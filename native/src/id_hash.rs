//! A fast hasher for maps keyed by node ids. The default SipHash resists
//! adversarial keys, which tree-assigned ids cannot be, at several times the cost.
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

const SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;

#[derive(Default, Clone, Copy)]
pub(crate) struct IdHasher(u64);

impl IdHasher {
    fn add(&mut self, value: u64) {
        self.0 = (self.0.rotate_left(5) ^ value).wrapping_mul(SEED);
    }
}

impl Hasher for IdHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        let (chunks, remainder) = bytes.as_chunks::<8>();
        for chunk in chunks {
            self.add(u64::from_le_bytes(*chunk));
        }
        for byte in remainder {
            self.add(u64::from(*byte));
        }
    }
    fn write_u32(&mut self, value: u32) {
        self.add(u64::from(value));
    }
    fn write_u64(&mut self, value: u64) {
        self.add(value);
    }
    fn write_usize(&mut self, value: usize) {
        self.add(value as u64);
    }
}

pub(crate) type IdMap<K, V> = HashMap<K, V, BuildHasherDefault<IdHasher>>;
pub(crate) type IdSet<K> = HashSet<K, BuildHasherDefault<IdHasher>>;
