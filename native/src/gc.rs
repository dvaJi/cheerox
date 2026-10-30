//! Reclaim detached native components that have no live JavaScript handles.
use std::collections::HashMap;

use crate::arena::DomArena;

#[derive(Debug)]
pub(crate) struct GcStats {
    pub live: u32,
    pub slots: u32,
    pub retained: u32,
    pub reclaimed: u32,
    pub free: Vec<u32>,
}

#[cfg(test)]
pub(crate) fn collect(arena: &mut DomArena, pins: &HashMap<u32, usize>) -> GcStats {
    collect_managed(arena, pins, true, 0)
}

/// Reclaims nodes connected to neither a pin, the root (with `keep_root`)
/// nor a slot below `keep_below`.
pub(crate) fn collect_managed(
    arena: &mut DomArena,
    pins: &HashMap<u32, usize>,
    keep_root: bool,
    keep_below: u32,
) -> GcStats {
    let mut marked = vec![false; arena.nodes.len()];
    let mut stack: Vec<u32> = if keep_root { vec![0] } else { Vec::new() };
    stack.extend(0..keep_below.min(arena.nodes.len() as u32));
    stack.extend(
        pins.iter()
            .filter_map(|(id, count)| (*count > 0).then_some(*id)),
    );
    // Following both directions marks the entire parent/child component. A
    // held descendant keeps its detached parent and siblings navigable. The
    // visited bitmap also bounds work for cyclic or inconsistent user graphs.
    while let Some(id) = stack.pop() {
        let Some(node) = arena.nodes.get(id as usize) else {
            continue;
        };
        if marked[id as usize] || node.kind == "released" {
            continue;
        }
        marked[id as usize] = true;
        stack.extend(node.parent);
        stack.extend(node.children.iter().copied());
    }

    let retained = pins
        .iter()
        .filter(|(id, count)| **count > 0 && marked.get(**id as usize) == Some(&true))
        .count() as u32;
    let mut reclaimed = 0;
    for (index, node) in arena.nodes.iter_mut().enumerate() {
        if marked[index] || node.kind == "released" {
            continue;
        }
        reclaimed += 1;
        node.kind = "released".into();
        node.name = None;
        node.data = None;
        node.attribs = Default::default();
        node.children = Vec::new();
        node.extras = Default::default();
        node.namespace = None;
        node.attribs_namespace = None;
        node.attribs_prefix = None;
        node.parent = None;
        node.prev = None;
        node.next = None;
    }
    while arena
        .nodes
        .last()
        .is_some_and(|node| node.kind == "released")
    {
        arena.nodes.pop();
    }
    if arena.nodes.capacity() > arena.nodes.len().saturating_mul(2).saturating_add(64) {
        arena.nodes.shrink_to_fit();
    }
    let free = arena
        .nodes
        .iter()
        .filter(|node| node.kind == "released")
        .map(|node| node.id)
        .collect::<Vec<_>>();
    arena.detached_since_collection = 0;
    arena.collected_live = arena.nodes.len() as u32 - free.len() as u32;
    GcStats {
        live: arena.nodes.len() as u32 - free.len() as u32,
        slots: arena.nodes.len() as u32,
        retained,
        reclaimed,
        free,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arena::DomNode;
    use serde_json::json;

    fn fixture() -> DomArena {
        let mut nodes = vec![DomNode::new("root")];
        nodes.extend((0..5).map(|_| DomNode::new("tag")));
        nodes[0].children = vec![1, 5];
        nodes[2].children = vec![3, 4];
        nodes[2].name = Some("detached".into());
        nodes[3].data = Some("payload".repeat(100));
        nodes[3].attribs.insert("key".into(), json!("value"));
        nodes[3].extras.insert("data".into(), json!({"held":true}));
        DomArena::from_records(nodes, json!({}))
    }

    #[test]
    fn held_detached_child_preserves_its_parent_and_sibling() {
        let mut arena = fixture();
        let stats = collect(&mut arena, &HashMap::from([(3, 2)]));
        assert_eq!(
            (stats.live, stats.slots, stats.retained, stats.reclaimed),
            (6, 6, 1, 0)
        );
        assert!(stats.free.is_empty());
        assert_eq!(arena.nodes[3].parent, Some(2));
        assert_eq!(arena.nodes[3].next, Some(4));
        assert_eq!(arena.nodes[2].children, vec![3, 4]);
    }

    #[test]
    fn unpinned_payloads_are_cleared_and_trailing_slots_trimmed() {
        let mut arena = fixture();
        let stats = collect(&mut arena, &HashMap::new());
        assert_eq!((stats.live, stats.slots, stats.reclaimed), (3, 6, 3));
        assert_eq!(stats.free, vec![2, 3, 4]);
        let node = &arena.nodes[3];
        assert_eq!(node.kind, "released");
        assert!(node.data.is_none() && node.name.is_none());
        assert!(node.attribs.len() == 0 && node.children.is_empty() && node.extras.is_empty());
        assert!(node.parent.is_none() && node.prev.is_none() && node.next.is_none());
        arena.detach(5);
        let stats = collect(&mut arena, &HashMap::from([(5, 0)]));
        assert_eq!(
            (stats.live, stats.slots, stats.retained, stats.reclaimed),
            (2, 2, 0, 1)
        );
        assert!(stats.free.is_empty());
        assert_eq!(collect(&mut arena, &HashMap::new()).reclaimed, 0);
    }

    #[test]
    fn cyclic_components_are_marked_once() {
        let mut arena = fixture();
        arena.nodes[2].parent = Some(3);
        arena.nodes[3].children.push(2);
        let stats = collect(&mut arena, &HashMap::from([(3, 1)]));
        assert_eq!((stats.live, stats.retained, stats.reclaimed), (6, 1, 0));
        let stats = collect(&mut arena, &HashMap::new());
        assert_eq!(stats.reclaimed, 3);
    }

    #[test]
    fn managed_detached_handle_does_not_retain_the_original_document() {
        let mut arena = fixture();
        let stats = collect_managed(&mut arena, &HashMap::from([(3, 1)]), false, 0);
        assert_eq!((stats.live, stats.retained, stats.reclaimed), (3, 1, 3));
        assert_eq!(arena.nodes[0].kind, "released");
        assert_eq!(arena.nodes[1].kind, "released");
        assert_eq!(arena.nodes[2].name.as_deref(), Some("detached"));
        assert_eq!(arena.nodes[3].parent, Some(2));
        assert_eq!(arena.nodes[3].next, Some(4));
    }
}
