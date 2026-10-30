//! Cheerio's `uniqueSort`: domutils' `uniqueSort` sorted with V8's
//! `Array.prototype.sort`.
//!
//! domutils' comparison is not a total order. Nodes in different trees compare
//! equal, and a text node compares before both its parent and its siblings in
//! either argument order. Which order Cheerio returns then depends on the
//! exact steps of V8's TimSort, so this module repeats them. A general sort
//! would return another order, and Rust's sorts may panic on such comparisons.
use crate::selector::SelectDom;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

/// `ids` without repeats, keeping each id's last occurrence, in the order
/// Cheerio's `uniqueSort` returns them.
pub(crate) fn unique_sort<D: SelectDom>(dom: &D, ids: &[u32]) -> Vec<u32> {
    let mut seen = HashSet::new();
    let mut unique: Vec<u32> = ids
        .iter()
        .rev()
        .copied()
        .filter(|id| seen.insert(*id))
        .collect();
    unique.reverse();
    let positions = Positions::new(dom, &unique);
    tim_sort(&mut unique, |a, b| positions.compare(*a, *b));
    unique
}

/// Whether domutils compares every pair of `ids` consistently with document
/// order, so any sort by local id returns Cheerio's order: they are all
/// elements, which domutils places on their own ancestor path.
pub(crate) fn is_document_ordered<D: SelectDom>(dom: &D, ids: &[u32]) -> bool {
    ids.iter().all(|id| has_children(dom, *id))
}

/// For each node, the path domutils' `compareDocumentPosition` builds: from
/// the root down to the node itself when it can have children, or else down
/// to its parent, with each path node's index among its parent's children.
struct Positions {
    paths: HashMap<u32, Vec<(u32, i64)>>,
}

impl Positions {
    fn new<D: SelectDom>(dom: &D, ids: &[u32]) -> Self {
        let mut sibling_indexes: HashMap<(u32, u32), i64> = HashMap::new();
        let mut indexed_parents: HashSet<u32> = HashSet::new();
        let mut paths = HashMap::with_capacity(ids.len());
        for id in ids {
            let start = if has_children(dom, *id) {
                Some(*id)
            } else {
                dom.parent(*id)
            };
            let mut path = Vec::new();
            let mut visited = HashSet::new();
            let mut current = start;
            while let Some(node) = current {
                if !visited.insert(node) {
                    break;
                }
                path.push(node);
                current = dom.parent(node);
            }
            path.reverse();
            let indexed: Vec<(u32, i64)> = path
                .iter()
                .enumerate()
                .map(|(depth, node)| {
                    let Some(parent) = depth.checked_sub(1).map(|depth| path[depth]) else {
                        return (*node, -1);
                    };
                    if indexed_parents.insert(parent) {
                        for (index, child) in dom.children(parent).iter().enumerate() {
                            sibling_indexes
                                .entry((parent, *child))
                                .or_insert(index as i64);
                        }
                    }
                    let index = sibling_indexes.get(&(parent, *node)).copied();
                    (*node, index.unwrap_or(-1))
                })
                .collect();
            paths.insert(*id, indexed);
        }
        Self { paths }
    }

    /// domutils' `uniqueSort` comparison of `a` and `b`.
    fn compare(&self, a: u32, b: u32) -> Ordering {
        if a == b {
            return Ordering::Equal;
        }
        let (a_path, b_path) = (&self.paths[&a], &self.paths[&b]);
        let shared = a_path
            .iter()
            .zip(b_path.iter())
            .take_while(|(a, b)| a.0 == b.0)
            .count();
        if shared == 0 {
            return Ordering::Equal;
        }
        let a_index = a_path.get(shared).map_or(-1, |(_, index)| *index);
        let b_index = b_path.get(shared).map_or(-1, |(_, index)| *index);
        if a_index > b_index {
            Ordering::Greater
        } else {
            Ordering::Less
        }
    }
}

fn has_children<D: SelectDom>(dom: &D, id: u32) -> bool {
    matches!(dom.kind(id), "tag" | "script" | "style" | "root" | "cdata")
}

const MINIMUM_GALLOP_WINS: usize = 7;

/// V8's TimSort, step for step, so comparisons that are not a total order
/// produce the order `Array.prototype.sort` produces.
fn tim_sort<T: Copy>(items: &mut [T], compare: impl Fn(&T, &T) -> Ordering) {
    let length = items.len();
    if length < 2 {
        return;
    }
    let mut state = SortState {
        items,
        compare,
        minimum_gallop: MINIMUM_GALLOP_WINS,
        runs: Vec::new(),
    };
    let minimum_run = minimum_run_length(length);
    let mut low = 0;
    let mut remaining = length;
    while remaining != 0 {
        let mut run = state.count_and_make_run(low, low + remaining);
        if run < minimum_run {
            let forced = minimum_run.min(remaining);
            state.binary_insertion_sort(low, low + run, low + forced);
            run = forced;
        }
        state.runs.push((low, run));
        state.merge_collapse();
        low += run;
        remaining -= run;
    }
    state.merge_force_collapse();
}

fn minimum_run_length(mut length: usize) -> usize {
    let mut remainder = 0;
    while length >= 64 {
        remainder |= length & 1;
        length >>= 1;
    }
    length + remainder
}

struct SortState<'a, T, C> {
    items: &'a mut [T],
    compare: C,
    minimum_gallop: usize,
    runs: Vec<(usize, usize)>,
}

impl<T: Copy, C: Fn(&T, &T) -> Ordering> SortState<'_, T, C> {
    fn is_less(&self, a: &T, b: &T) -> bool {
        (self.compare)(a, b) == Ordering::Less
    }

    fn count_and_make_run(&mut self, low_start: usize, high: usize) -> usize {
        let low = low_start + 1;
        if low == high {
            return 1;
        }
        let mut run = 2;
        let is_descending = self.is_less(&self.items[low], &self.items[low - 1]);
        let mut previous = self.items[low];
        for index in low + 1..high {
            let current = self.items[index];
            let is_current_less = self.is_less(&current, &previous);
            if is_descending != is_current_less {
                break;
            }
            previous = current;
            run += 1;
        }
        if is_descending {
            self.items[low_start..low_start + run].reverse();
        }
        run
    }

    fn binary_insertion_sort(&mut self, low: usize, start: usize, high: usize) {
        let start = if low == start { start + 1 } else { start };
        for start in start..high {
            let pivot = self.items[start];
            let (mut left, mut right) = (low, start);
            while left < right {
                let middle = left + ((right - left) >> 1);
                if self.is_less(&pivot, &self.items[middle]) {
                    right = middle;
                } else {
                    left = middle + 1;
                }
            }
            self.items.copy_within(left..start, left + 1);
            self.items[left] = pivot;
        }
    }

    fn run_length(&self, index: usize) -> usize {
        self.runs[index].1
    }

    fn is_run_invariant_established(&self, index: usize) -> bool {
        index < 2
            || self.run_length(index - 2) > self.run_length(index - 1) + self.run_length(index)
    }

    fn merge_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut index = self.runs.len() - 2;
            if !self.is_run_invariant_established(index + 1)
                || !self.is_run_invariant_established(index)
            {
                if self.run_length(index - 1) < self.run_length(index + 1) {
                    index -= 1;
                }
                self.merge_at(index);
            } else if self.run_length(index) <= self.run_length(index + 1) {
                self.merge_at(index);
            } else {
                break;
            }
        }
    }

    fn merge_force_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut index = self.runs.len() - 2;
            if index > 0 && self.run_length(index - 1) < self.run_length(index + 1) {
                index -= 1;
            }
            self.merge_at(index);
        }
    }

    fn merge_at(&mut self, index: usize) {
        let (mut base_a, mut length_a) = self.runs[index];
        let (base_b, mut length_b) = self.runs[index + 1];
        self.runs[index].1 = length_a + length_b;
        self.runs.remove(index + 1);

        let key_right = self.items[base_b];
        let skipped = self.gallop_right(Source::Items, &key_right, base_a, length_a, 0);
        base_a += skipped;
        length_a -= skipped;
        if length_a == 0 {
            return;
        }
        let key_left = self.items[base_a + length_a - 1];
        length_b = self.gallop_left(Source::Items, &key_left, base_b, length_b, length_b - 1);
        if length_b == 0 {
            return;
        }
        if length_a <= length_b {
            self.merge_low(base_a, length_a, base_b, length_b);
        } else {
            self.merge_high(base_a, length_a, base_b, length_b);
        }
    }

    fn element(&self, source: Source<'_, T>, index: usize) -> T {
        match source {
            Source::Items => self.items[index],
            Source::Temporary(temporary) => temporary[index],
        }
    }

    /// The position in the run at `base` before the first element not less
    /// than `key`, searched from `hint`.
    fn gallop_left(
        &self,
        source: Source<'_, T>,
        key: &T,
        base: usize,
        length: usize,
        hint: usize,
    ) -> usize {
        let mut last_offset: isize = 0;
        let mut offset: isize = 1;
        let hint = hint as isize;
        let length = length as isize;
        let at = |position: isize| self.element(source, base + position as usize);
        if self.is_less(&at(hint), key) {
            let maximum_offset = length - hint;
            while offset < maximum_offset {
                if !self.is_less(&at(hint + offset), key) {
                    break;
                }
                last_offset = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(maximum_offset);
            last_offset += hint;
            offset += hint;
        } else {
            let maximum_offset = hint + 1;
            while offset < maximum_offset {
                if self.is_less(&at(hint - offset), key) {
                    break;
                }
                last_offset = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(maximum_offset);
            let previous = last_offset;
            last_offset = hint - offset;
            offset = hint - previous;
        }
        last_offset += 1;
        while last_offset < offset {
            let middle = last_offset + ((offset - last_offset) >> 1);
            if self.is_less(&at(middle), key) {
                last_offset = middle + 1;
            } else {
                offset = middle;
            }
        }
        offset as usize
    }

    /// The position in the run at `base` after the last element not greater
    /// than `key`, searched from `hint`.
    fn gallop_right(
        &self,
        source: Source<'_, T>,
        key: &T,
        base: usize,
        length: usize,
        hint: usize,
    ) -> usize {
        let mut last_offset: isize = 0;
        let mut offset: isize = 1;
        let hint = hint as isize;
        let length = length as isize;
        let at = |position: isize| self.element(source, base + position as usize);
        if self.is_less(key, &at(hint)) {
            let maximum_offset = hint + 1;
            while offset < maximum_offset {
                if !self.is_less(key, &at(hint - offset)) {
                    break;
                }
                last_offset = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(maximum_offset);
            let previous = last_offset;
            last_offset = hint - offset;
            offset = hint - previous;
        } else {
            let maximum_offset = length - hint;
            while offset < maximum_offset {
                if self.is_less(key, &at(hint + offset)) {
                    break;
                }
                last_offset = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(maximum_offset);
            last_offset += hint;
            offset += hint;
        }
        last_offset += 1;
        while last_offset < offset {
            let middle = last_offset + ((offset - last_offset) >> 1);
            if self.is_less(key, &at(middle)) {
                offset = middle;
            } else {
                last_offset = middle + 1;
            }
        }
        offset as usize
    }

    fn merge_low(&mut self, base_a: usize, length_a: usize, base_b: usize, length_b: usize) {
        let temporary: Vec<T> = self.items[base_a..base_a + length_a].to_vec();
        let (mut length_a, mut length_b) = (length_a, length_b);
        let mut destination = base_a;
        let mut cursor_temporary = 0;
        let mut cursor_b = base_b;
        self.items[destination] = self.items[cursor_b];
        destination += 1;
        cursor_b += 1;
        length_b -= 1;
        let outcome = 'merge: {
            if length_b == 0 {
                break 'merge LowOutcome::Succeed;
            }
            if length_a == 1 {
                break 'merge LowOutcome::CopyB;
            }
            let mut minimum_gallop = self.minimum_gallop;
            loop {
                let mut wins_a = 0;
                let mut wins_b = 0;
                loop {
                    if self.is_less(&self.items[cursor_b], &temporary[cursor_temporary]) {
                        self.items[destination] = self.items[cursor_b];
                        destination += 1;
                        cursor_b += 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 0 {
                            break 'merge LowOutcome::Succeed;
                        }
                        if wins_b >= minimum_gallop {
                            break;
                        }
                    } else {
                        self.items[destination] = temporary[cursor_temporary];
                        destination += 1;
                        cursor_temporary += 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 1 {
                            break 'merge LowOutcome::CopyB;
                        }
                        if wins_a >= minimum_gallop {
                            break;
                        }
                    }
                }
                minimum_gallop += 1;
                let mut is_first_iteration = true;
                while wins_a >= MINIMUM_GALLOP_WINS
                    || wins_b >= MINIMUM_GALLOP_WINS
                    || is_first_iteration
                {
                    is_first_iteration = false;
                    minimum_gallop = minimum_gallop.saturating_sub(1).max(1);
                    self.minimum_gallop = minimum_gallop;

                    let key = self.items[cursor_b];
                    wins_a = self.gallop_right(
                        Source::Temporary(&temporary),
                        &key,
                        cursor_temporary,
                        length_a,
                        0,
                    );
                    if wins_a > 0 {
                        self.items[destination..destination + wins_a].copy_from_slice(
                            &temporary[cursor_temporary..cursor_temporary + wins_a],
                        );
                        destination += wins_a;
                        cursor_temporary += wins_a;
                        length_a -= wins_a;
                        if length_a == 1 {
                            break 'merge LowOutcome::CopyB;
                        }
                        if length_a == 0 {
                            break 'merge LowOutcome::Succeed;
                        }
                    }
                    self.items[destination] = self.items[cursor_b];
                    destination += 1;
                    cursor_b += 1;
                    length_b -= 1;
                    if length_b == 0 {
                        break 'merge LowOutcome::Succeed;
                    }

                    let key = temporary[cursor_temporary];
                    wins_b = self.gallop_left(Source::Items, &key, cursor_b, length_b, 0);
                    if wins_b > 0 {
                        self.items
                            .copy_within(cursor_b..cursor_b + wins_b, destination);
                        destination += wins_b;
                        cursor_b += wins_b;
                        length_b -= wins_b;
                        if length_b == 0 {
                            break 'merge LowOutcome::Succeed;
                        }
                    }
                    self.items[destination] = temporary[cursor_temporary];
                    destination += 1;
                    cursor_temporary += 1;
                    length_a -= 1;
                    if length_a == 1 {
                        break 'merge LowOutcome::CopyB;
                    }
                }
                minimum_gallop += 1;
                self.minimum_gallop = minimum_gallop;
            }
        };
        match outcome {
            LowOutcome::Succeed => {
                if length_a > 0 {
                    self.items[destination..destination + length_a]
                        .copy_from_slice(&temporary[cursor_temporary..cursor_temporary + length_a]);
                }
            }
            LowOutcome::CopyB => {
                self.items
                    .copy_within(cursor_b..cursor_b + length_b, destination);
                self.items[destination + length_b] = temporary[cursor_temporary];
            }
        }
    }

    fn merge_high(&mut self, base_a: usize, length_a: usize, base_b: usize, length_b: usize) {
        let temporary: Vec<T> = self.items[base_b..base_b + length_b].to_vec();
        let (mut length_a, mut length_b) = (length_a, length_b);
        // Cursors may step one past the start of their runs, which signed
        // positions represent as -1.
        let mut destination = (base_b + length_b - 1) as isize;
        let mut cursor_temporary = length_b as isize - 1;
        let mut cursor_a = (base_a + length_a - 1) as isize;
        self.items[destination as usize] = self.items[cursor_a as usize];
        destination -= 1;
        cursor_a -= 1;
        length_a -= 1;
        let outcome = 'merge: {
            if length_a == 0 {
                break 'merge HighOutcome::Succeed;
            }
            if length_b == 1 {
                break 'merge HighOutcome::CopyA;
            }
            let mut minimum_gallop = self.minimum_gallop;
            loop {
                let mut wins_a = 0;
                let mut wins_b = 0;
                loop {
                    if self.is_less(
                        &temporary[cursor_temporary as usize],
                        &self.items[cursor_a as usize],
                    ) {
                        self.items[destination as usize] = self.items[cursor_a as usize];
                        destination -= 1;
                        cursor_a -= 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 0 {
                            break 'merge HighOutcome::Succeed;
                        }
                        if wins_a >= minimum_gallop {
                            break;
                        }
                    } else {
                        self.items[destination as usize] = temporary[cursor_temporary as usize];
                        destination -= 1;
                        cursor_temporary -= 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 1 {
                            break 'merge HighOutcome::CopyA;
                        }
                        if wins_b >= minimum_gallop {
                            break;
                        }
                    }
                }
                minimum_gallop += 1;
                let mut is_first_iteration = true;
                while wins_a >= MINIMUM_GALLOP_WINS
                    || wins_b >= MINIMUM_GALLOP_WINS
                    || is_first_iteration
                {
                    is_first_iteration = false;
                    minimum_gallop = minimum_gallop.saturating_sub(1).max(1);
                    self.minimum_gallop = minimum_gallop;

                    let key = temporary[cursor_temporary as usize];
                    let position =
                        self.gallop_right(Source::Items, &key, base_a, length_a, length_a - 1);
                    wins_a = length_a - position;
                    if wins_a > 0 {
                        destination -= wins_a as isize;
                        cursor_a -= wins_a as isize;
                        let from = (cursor_a + 1) as usize;
                        self.items
                            .copy_within(from..from + wins_a, (destination + 1) as usize);
                        length_a -= wins_a;
                        if length_a == 0 {
                            break 'merge HighOutcome::Succeed;
                        }
                    }
                    self.items[destination as usize] = temporary[cursor_temporary as usize];
                    destination -= 1;
                    cursor_temporary -= 1;
                    length_b -= 1;
                    if length_b == 1 {
                        break 'merge HighOutcome::CopyA;
                    }

                    let key = self.items[cursor_a as usize];
                    let position = self.gallop_left(
                        Source::Temporary(&temporary),
                        &key,
                        0,
                        length_b,
                        length_b - 1,
                    );
                    wins_b = length_b - position;
                    if wins_b > 0 {
                        destination -= wins_b as isize;
                        cursor_temporary -= wins_b as isize;
                        let from = (cursor_temporary + 1) as usize;
                        let to = (destination + 1) as usize;
                        self.items[to..to + wins_b]
                            .copy_from_slice(&temporary[from..from + wins_b]);
                        length_b -= wins_b;
                        if length_b == 1 {
                            break 'merge HighOutcome::CopyA;
                        }
                        if length_b == 0 {
                            break 'merge HighOutcome::Succeed;
                        }
                    }
                    self.items[destination as usize] = self.items[cursor_a as usize];
                    destination -= 1;
                    cursor_a -= 1;
                    length_a -= 1;
                    if length_a == 0 {
                        break 'merge HighOutcome::Succeed;
                    }
                }
                minimum_gallop += 1;
                self.minimum_gallop = minimum_gallop;
            }
        };
        match outcome {
            HighOutcome::Succeed => {
                if length_b > 0 {
                    let to = (destination - (length_b as isize - 1)) as usize;
                    self.items[to..to + length_b].copy_from_slice(&temporary[..length_b]);
                }
            }
            HighOutcome::CopyA => {
                destination -= length_a as isize;
                cursor_a -= length_a as isize;
                let from = (cursor_a + 1) as usize;
                self.items
                    .copy_within(from..from + length_a, (destination + 1) as usize);
                self.items[destination as usize] = temporary[cursor_temporary as usize];
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Source<'a, T> {
    Items,
    Temporary(&'a [T]),
}

enum LowOutcome {
    Succeed,
    CopyB,
}

enum HighOutcome {
    Succeed,
    CopyA,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_consistent_comparisons_stably() {
        let mut state = 0x2545_f491_u64;
        for length in [0, 1, 2, 5, 31, 64, 65, 200, 1000, 5000] {
            let mut items: Vec<(u32, usize)> = (0..length)
                .map(|index| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    ((state % 50) as u32, index)
                })
                .collect();
            let mut expected = items.clone();
            expected.sort_by_key(|item| item.0);
            tim_sort(&mut items, |a, b| a.0.cmp(&b.0));
            assert_eq!(items, expected);
        }
    }

    #[test]
    fn terminates_on_inconsistent_comparisons() {
        let mut items: Vec<u32> = (0..3000).collect();
        tim_sort(&mut items, |a, b| {
            if (a ^ b) % 3 == 0 {
                Ordering::Less
            } else {
                b.cmp(a)
            }
        });
        let mut sorted = items.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..3000).collect::<Vec<_>>());
    }
}
