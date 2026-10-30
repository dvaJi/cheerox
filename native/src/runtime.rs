//! One process-wide CPU budget, shared by batches and streaming parsers.
use napi::{Error, Result, Status};
use napi_derive::napi;
use rayon::prelude::*;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};

struct Configuration {
    threads: usize,
    started: bool,
    pool: Option<Arc<rayon::ThreadPool>>,
    error: Option<String>,
}
struct Runtime {
    configuration: Mutex<Configuration>,
    used: Mutex<u32>,
    wake: Condvar,
    batches: AtomicU32,
    peak: AtomicU32,
}
fn runtime() -> &'static Runtime {
    static SHARED: OnceLock<Runtime> = OnceLock::new();
    SHARED.get_or_init(|| {
        let default = std::thread::available_parallelism()
            .map_or(1, usize::from)
            .min(256);
        let requested = std::env::var("CHEEROX_THREADS")
            .or_else(|_| std::env::var("RUSTEERIO_THREADS"))
            .ok();
        let parsed = requested
            .as_ref()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| (1..=256).contains(value));
        Runtime {
            configuration: Mutex::new(Configuration {
                threads: parsed.unwrap_or(default),
                started: false,
                pool: None,
                error: requested
                    .filter(|_| parsed.is_none())
                    .map(|_| "CHEEROX_THREADS must be an integer from 1 to 256".into()),
            }),
            used: Mutex::new(0),
            wake: Condvar::new(),
            batches: AtomicU32::new(0),
            peak: AtomicU32::new(0),
        }
    })
}

#[napi(object)]
pub struct WorkerPoolInfo {
    pub threads: u32,
    pub active_batches: u32,
    pub active_workers: u32,
    pub peak_active_workers: u32,
}

#[napi]
pub fn worker_pool_info() -> WorkerPoolInfo {
    let shared = runtime();
    WorkerPoolInfo {
        threads: shared.configuration.lock().unwrap().threads as u32,
        active_batches: shared.batches.load(Ordering::Relaxed),
        active_workers: *shared.used.lock().unwrap(),
        peak_active_workers: shared.peak.load(Ordering::Relaxed),
    }
}

#[napi]
pub fn configure_worker_pool(threads: u32) -> Result<WorkerPoolInfo> {
    if !(1..=256).contains(&threads) {
        return Err(Error::new(
            Status::InvalidArg,
            "Worker budget must be an integer from 1 to 256",
        ));
    }
    {
        let mut config = runtime().configuration.lock().unwrap();
        if config.started && config.threads != threads as usize {
            return Err(Error::new(
                Status::InvalidArg,
                "Configure the worker budget before starting native asynchronous work",
            ));
        }
        if config.threads != threads as usize {
            // A pool that only internal work has created yet is rebuilt at the new size.
            config.pool = None;
        }
        config.threads = threads as usize;
        config.error = None;
    }
    Ok(worker_pool_info())
}

pub(crate) struct Permit;
pub(crate) fn permit() -> Result<Permit> {
    let shared = runtime();
    let limit = {
        let mut config = shared.configuration.lock().unwrap();
        if let Some(error) = &config.error {
            return Err(Error::new(Status::InvalidArg, error.clone()));
        }
        config.started = true;
        config.threads as u32
    };
    let mut used = shared.used.lock().unwrap();
    while *used >= limit {
        used = shared.wake.wait(used).unwrap();
    }
    *used += 1;
    shared.peak.fetch_max(*used, Ordering::Relaxed);
    Ok(Permit)
}
impl Drop for Permit {
    fn drop(&mut self) {
        let shared = runtime();
        *shared.used.lock().unwrap() -= 1;
        shared.wake.notify_one();
    }
}

/// The process-wide worker pool, created on first use with the configured size.
fn shared_pool() -> Result<Arc<rayon::ThreadPool>> {
    pool(true)
}

/// The pool for work JavaScript did not ask for, which must not fix the
/// configured budget: the caller may configure it later.
fn internal_pool() -> Result<Arc<rayon::ThreadPool>> {
    pool(false)
}

fn pool(is_requested: bool) -> Result<Arc<rayon::ThreadPool>> {
    let mut config = runtime().configuration.lock().unwrap();
    if let Some(error) = &config.error {
        return Err(Error::new(Status::InvalidArg, error.clone()));
    }
    config.started |= is_requested;
    if config.pool.is_none() {
        config.pool = Some(Arc::new(
            rayon::ThreadPoolBuilder::new()
                .num_threads(config.threads)
                .build()
                .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?,
        ));
    }
    Ok(config.pool.as_ref().unwrap().clone())
}

/// Values the pool has yet to drop. Past the limit they drop here, so busy
/// workers cannot let freed memory pile up.
static PENDING_RELEASES: AtomicU32 = AtomicU32::new(0);
const MAXIMUM_PENDING_RELEASES: u32 = 2;

/// Drops `value` on the shared pool or the release thread if either exists
/// and is keeping up, or here. It never starts either: finalizers call it
/// during garbage collection.
pub(crate) fn release_later<T: Send + 'static>(value: T) {
    if PENDING_RELEASES.load(Ordering::Relaxed) >= MAXIMUM_PENDING_RELEASES {
        return drop(value);
    }
    let pool = runtime().configuration.lock().unwrap().pool.clone();
    if let Some(pool) = pool {
        PENDING_RELEASES.fetch_add(1, Ordering::Relaxed);
        return pool.spawn(move || {
            drop(value);
            PENDING_RELEASES.fetch_sub(1, Ordering::Relaxed);
        });
    }
    if let Some(release_thread) = RELEASE_THREAD.get() {
        PENDING_RELEASES.fetch_add(1, Ordering::Relaxed);
        if let Err(unsent) = release_thread.send(Box::new(value)) {
            PENDING_RELEASES.fetch_sub(1, Ordering::Relaxed);
            drop(unsent);
        }
        return;
    }
    drop(value)
}

static RELEASE_THREAD: OnceLock<mpsc::Sender<Box<dyn Send>>> = OnceLock::new();

/// Starts the thread that frees released documents while no worker pool
/// exists, so freeing large trees does not stall JavaScript. Documents large
/// enough to be released later start it when they are created, because
/// finalizers must not create threads.
/// Trees with at least this many nodes return the parse's freed memory to
/// the system once built.
#[cfg(target_os = "linux")]
const RETURN_PAGES_NODES: usize = 100_000;

#[cfg(target_os = "linux")]
extern "C" {
    fn mi_collect(force: bool);
}

/// Building a large tree grows and then frees big buffers, such as a node
/// vector that doubled several times. mimalloc keeps freed pages resident for
/// reuse; after a large parse, return them on the parsing thread instead.
pub(crate) fn return_parse_pages(nodes: usize) {
    #[cfg(target_os = "linux")]
    if nodes >= RETURN_PAGES_NODES {
        // SAFETY: mimalloc's own collection frees only memory no block uses.
        unsafe { mi_collect(true) };
    }
    #[cfg(not(target_os = "linux"))]
    let _ = nodes;
}

pub(crate) fn start_release_thread() {
    RELEASE_THREAD.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<Box<dyn Send>>();
        // A thread that cannot start drops its receiver; sends then fail and
        // values drop on the caller.
        let _ = std::thread::Builder::new()
            .name("rusteerio-release".into())
            .spawn(move || {
                for value in receiver {
                    drop(value);
                    PENDING_RELEASES.fetch_sub(1, Ordering::Relaxed);
                }
            });
        sender
    });
}

/// Permits for up to `wanted` workers that are free now, without waiting.
fn available_permits(wanted: usize) -> Vec<Permit> {
    let shared = runtime();
    let limit = {
        let config = shared.configuration.lock().unwrap();
        if config.error.is_some() {
            return Vec::new();
        }
        config.threads as u32
    };
    let mut used = shared.used.lock().unwrap();
    let count = (limit.saturating_sub(*used) as usize).min(wanted);
    *used += count as u32;
    shared.peak.fetch_max(*used, Ordering::Relaxed);
    (0..count).map(|_| Permit).collect()
}

/// Maps chunks of `0..count` in order. It uses only the shared pool's workers
/// that are idle now, so work on the JavaScript thread never waits on other
/// batches; with none idle, or little work, it runs on the calling thread.
pub(crate) fn chunked_map<U: Send>(
    count: usize,
    chunk: usize,
    operation: impl Fn(std::ops::Range<usize>) -> Vec<U> + Sync + Send,
) -> Vec<U> {
    // A pool worker already holds its batch's permit; waiting there on jobs
    // installed behind other batches' work could leave every worker waiting.
    if rayon::current_thread_index().is_some() {
        return operation(0..count);
    }
    let chunks = count.div_ceil(chunk.max(1));
    let permits = if chunks > 1 {
        available_permits(chunks)
    } else {
        Vec::new()
    };
    let pool = (permits.len() > 1).then(internal_pool).and_then(Result::ok);
    let Some(pool) = pool else {
        drop(permits);
        return operation(0..count);
    };
    let _batch = batch();
    let size = count.div_ceil(permits.len());
    let ranges: Vec<_> = (0..count)
        .step_by(size)
        .map(|start| start..(start + size).min(count))
        .collect();
    let results: Vec<Vec<U>> = pool.install(|| ranges.into_par_iter().map(&operation).collect());
    drop(permits);
    let mut merged = Vec::with_capacity(results.iter().map(Vec::len).sum());
    for chunk in results {
        merged.extend(chunk);
    }
    merged
}

pub(crate) struct Batch;
pub(crate) fn batch() -> Batch {
    runtime().batches.fetch_add(1, Ordering::Relaxed);
    Batch
}
impl Drop for Batch {
    fn drop(&mut self) {
        runtime().batches.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Maps `items` in order, on at most `threads` threads within the
/// process-wide budget. The calling thread waits for one permit and maps
/// items itself; pool workers help only with permits that are free now.
/// Pool jobs therefore never wait for permits, and a free permit always has
/// an idle worker: a worker that waited could hold the thread a permit's
/// holder needs in order to finish.
pub(crate) fn parallel_map<T: Sync, U: Send>(
    items: &[T],
    threads: usize,
    operation: impl Fn(&T) -> Result<U> + Sync + Send,
) -> Result<Vec<U>> {
    let _batch = batch();
    let results: Vec<Mutex<Option<Result<U>>>> = items.iter().map(|_| Mutex::new(None)).collect();
    let next = AtomicUsize::new(0);
    let map_remaining = || loop {
        let index = next.fetch_add(1, Ordering::Relaxed);
        let Some(item) = items.get(index) else {
            break;
        };
        *results[index].lock().unwrap() = Some(operation(item));
    };
    // A pool worker already holds the permit of the job it runs.
    let own = if rayon::current_thread_index().is_some() {
        None
    } else {
        Some(permit()?)
    };
    let wanted_helpers = threads.max(1).min(items.len()).saturating_sub(1);
    let helpers = if own.is_some() && wanted_helpers > 0 {
        available_permits(wanted_helpers)
    } else {
        Vec::new()
    };
    if helpers.is_empty() {
        map_remaining();
    } else {
        let pool = shared_pool()?;
        pool.in_place_scope(|scope| {
            for helper in helpers {
                scope.spawn(|_| {
                    map_remaining();
                    drop(helper);
                });
            }
            map_remaining();
        });
    }
    drop(own);
    results
        .into_iter()
        .map(|result| result.into_inner().unwrap().expect("every item ran"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_budget_and_order_survive_concurrent_batches() {
        let budget = worker_pool_info().threads;
        let inputs: Vec<_> = (0..32).collect();
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4)
                .map(|_| scope.spawn(|| parallel_map(&inputs, 2, |value| Ok(value * 2)).unwrap()))
                .collect();
            for handle in handles {
                assert_eq!(
                    handle.join().unwrap(),
                    inputs.iter().map(|value| value * 2).collect::<Vec<_>>()
                );
            }
        });
        let info = worker_pool_info();
        assert!(info.peak_active_workers <= budget);
    }
}
