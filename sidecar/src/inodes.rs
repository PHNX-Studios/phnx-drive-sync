//! Path <-> inode mapping.
//!
//! Paths are relative to the tree root, as raw bytes ('' = root). Inode numbers
//! are derived from a SHA-1 of the path so they are stable across sidecar
//! restarts; mappings are never forgotten, so a re-lookup reuses the same ino.

use std::collections::HashMap;

use sha1::{Digest, Sha1};

pub const ROOT_INO: u64 = 1;
const MASK_62: u64 = (1 << 62) - 1;

pub type Rel = Vec<u8>;

pub struct Inodes {
    ino_of: HashMap<Rel, u64>,
    path_of: HashMap<u64, Rel>,
}

impl Inodes {
    pub fn new() -> Self {
        let mut s = Inodes {
            ino_of: HashMap::new(),
            path_of: HashMap::new(),
        };
        s.ino_of.insert(Vec::new(), ROOT_INO);
        s.path_of.insert(ROOT_INO, Vec::new());
        s
    }

    pub fn ino_for(&mut self, rel: &[u8]) -> u64 {
        if let Some(&i) = self.ino_of.get(rel) {
            return i;
        }
        let mut digest = low_bits(&Sha1::digest(rel));
        let mut salt: u64 = 0;
        loop {
            let i = 2 + ((digest ^ (salt << 1)) & MASK_62);
            match self.path_of.get(&i) {
                Some(owner) if owner.as_slice() != rel => {}
                _ => {
                    self.ino_of.insert(rel.to_vec(), i);
                    self.path_of.insert(i, rel.to_vec());
                    return i;
                }
            }
            salt += 1;
            let mut h = Sha1::new();
            h.update(rel);
            h.update(format!("\0{salt}").as_bytes());
            digest = low_bits(&h.finalize());
        }
    }

    pub fn rel_of(&self, ino: u64) -> Option<Rel> {
        self.path_of.get(&ino).cloned()
    }

    /// Keep the inode of a renamed entry (children keep their own mappings).
    pub fn rename(&mut self, from: &[u8], to: &[u8]) {
        if let Some(i) = self.ino_of.remove(from) {
            self.path_of.insert(i, to.to_vec());
            self.ino_of.insert(to.to_vec(), i);
        }
    }
}

/// The digest as a big integer, masked to its low 62 bits (its last 8 bytes).
fn low_bits(digest: &[u8]) -> u64 {
    let tail: [u8; 8] = digest[digest.len() - 8..].try_into().unwrap();
    u64::from_be_bytes(tail) & MASK_62
}

pub fn parent_rel(rel: &[u8]) -> &[u8] {
    match rel.iter().rposition(|&b| b == b'/') {
        Some(i) => &rel[..i],
        None => b"",
    }
}

pub fn join_rel(parent: &[u8], name: &[u8]) -> Rel {
    if parent.is_empty() {
        return name.to_vec();
    }
    let mut r = Vec::with_capacity(parent.len() + 1 + name.len());
    r.extend_from_slice(parent);
    r.push(b'/');
    r.extend_from_slice(name);
    r
}

/// True if any component is a trash dir (`.Trash` or `.Trash-<digits>`);
/// mirrors filters.ts isFiltered.
pub fn is_trash_target(rel: &[u8]) -> bool {
    rel.split(|&b| b == b'/').any(|seg| {
        seg == b".Trash"
            || seg
                .strip_prefix(b".Trash-")
                .is_some_and(|d| !d.is_empty() && d.iter().all(u8::is_ascii_digit))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_is_one() {
        let mut m = Inodes::new();
        assert_eq!(m.ino_for(b""), ROOT_INO);
        assert_eq!(m.rel_of(ROOT_INO).unwrap(), b"");
    }

    #[test]
    fn matches_the_python_derivation() {
        // python: 2 + (int(hashlib.sha1(b'p.txt').hexdigest(), 16) & ((1 << 62) - 1))
        let mut m = Inodes::new();
        let digest = Sha1::digest(b"p.txt");
        let want = 2 + (u128::from_be_bytes(digest[4..20].try_into().unwrap()) as u64 & MASK_62);
        assert_eq!(m.ino_for(b"p.txt"), want);
    }

    #[test]
    fn collision_moves_to_a_salted_ino() {
        let mut m = Inodes::new();
        let a = m.ino_for(b"a");
        // squat a's natural slot with another path
        m.path_of.insert(a, b"squatter".to_vec());
        m.ino_of.remove(b"a".as_slice());
        let b = m.ino_for(b"a");
        assert_ne!(a, b);
        assert_eq!(m.rel_of(b).unwrap(), b"a");
    }

    #[test]
    fn non_utf8_names_hash_their_bytes() {
        let mut m = Inodes::new();
        let i = m.ino_for(b"caf\xe9.txt");
        assert!(i >= 2);
        assert_eq!(m.rel_of(i).unwrap(), b"caf\xe9.txt");
    }

    #[test]
    fn rename_keeps_the_ino() {
        let mut m = Inodes::new();
        let i = m.ino_for(b"x");
        m.rename(b"x", b"d/y");
        assert_eq!(m.ino_for(b"d/y"), i);
        assert_eq!(m.rel_of(i).unwrap(), b"d/y");
    }

    #[test]
    fn rel_helpers() {
        assert_eq!(parent_rel(b"a/b/c"), b"a/b");
        assert_eq!(parent_rel(b"a"), b"");
        assert_eq!(join_rel(b"", b"a"), b"a");
        assert_eq!(join_rel(b"a", b"b"), b"a/b");
    }

    #[test]
    fn trash_targets() {
        assert!(is_trash_target(b".Trash-1000/files/x"));
        assert!(is_trash_target(b"a/.Trash/x"));
        assert!(!is_trash_target(b".Trash-abc/x"));
        assert!(!is_trash_target(b".Trash-/x"));
        assert!(!is_trash_target(b".Trashy/x"));
    }
}
