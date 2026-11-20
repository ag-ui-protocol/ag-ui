//! Cooperative cancellation, without a runtime.
//!
//! A transport trips the token when the client disconnects or a deadline
//! passes; the run notices and unwinds. There is deliberately no
//! `tokio_util::CancellationToken` here — this crate must build for wasm and
//! for non-tokio executors, so the token is an [`AtomicBool`] plus a waker list.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

/// A shared "stop now" flag.
///
/// Cloning is cheap and every clone refers to the same flag, so a transport can
/// keep one and hand another to the run.
#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    inner: Arc<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    cancelled: AtomicBool,
    wakers: Mutex<Vec<Waiter>>,
}

#[derive(Debug)]
struct Waiter {
    registration: Arc<()>,
    waker: Waker,
}

impl CancellationToken {
    /// A fresh, un-cancelled token.
    pub fn new() -> Self {
        Self::default()
    }

    /// Trips the token and wakes everything waiting on it.
    ///
    /// Idempotent — cancelling twice is a no-op.
    pub fn cancel(&self) {
        if !self.inner.cancelled.swap(true, Ordering::SeqCst) {
            // Waking can execute arbitrary executor code, including dropping
            // another waiter. Never call it while holding the registry lock.
            let wakers = std::mem::take(&mut *lock(&self.inner.wakers));
            for waiter in wakers {
                waiter.waker.wake();
            }
        }
    }

    /// Whether the token has been tripped.
    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once the token is tripped.
    ///
    /// Use it to race an in-flight model call:
    ///
    /// ```
    /// # use ag_ui::server::CancellationToken;
    /// # let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
    /// # rt.block_on(async {
    /// let token = CancellationToken::new();
    /// token.cancel();
    /// token.cancelled().await;
    /// # });
    /// ```
    pub fn cancelled(&self) -> Cancelled {
        Cancelled {
            token: self.clone(),
            registration: Arc::new(()),
        }
    }
}

/// The future returned by [`CancellationToken::cancelled`].
///
/// It owns a clone of the token rather than borrowing one, so an agent can
/// hold this `'static` future across an await without borrowing the run
/// context. Each future has its own waiter registration, removed on drop.
#[derive(Debug)]
#[must_use = "a future does nothing unless awaited"]
pub struct Cancelled {
    token: CancellationToken,
    registration: Arc<()>,
}

impl Clone for Cancelled {
    fn clone(&self) -> Self {
        // Each future owns a separate registration even when both are polled
        // by the same task. Dropping one must not unregister the other.
        self.token.cancelled()
    }
}

impl Drop for Cancelled {
    fn drop(&mut self) {
        let removed = {
            let mut wakers = lock(&self.token.inner.wakers);
            wakers
                .iter()
                .position(|waiter| Arc::ptr_eq(&waiter.registration, &self.registration))
                .map(|index| wakers.swap_remove(index))
        };
        // A RawWaker's drop callback may also re-enter the executor.
        drop(removed);
    }
}

impl Future for Cancelled {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.token.is_cancelled() {
            return Poll::Ready(());
        }
        let candidate = cx.waker().clone();
        let mut wakers = lock(&self.token.inner.wakers);
        // Re-check under the lock: `cancel` may have drained the list between
        // the load above and here, and would then never see our waker.
        if self.token.is_cancelled() {
            return Poll::Ready(());
        }
        if let Some(waiter) = wakers
            .iter_mut()
            .find(|waiter| Arc::ptr_eq(&waiter.registration, &self.registration))
        {
            if !waiter.waker.will_wake(&candidate) {
                let previous = std::mem::replace(&mut waiter.waker, candidate);
                drop(wakers);
                drop(previous);
            }
        } else {
            wakers.push(Waiter {
                registration: self.registration.clone(),
                waker: candidate,
            });
        }
        Poll::Pending
    }
}

/// A poisoned waker list is still a perfectly good waker list: the only code
/// that touches it cannot panic while holding the guard.
fn lock(mutex: &Mutex<Vec<Waiter>>) -> std::sync::MutexGuard<'_, Vec<Waiter>> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::task::Wake;

    #[derive(Default)]
    struct CountWake(AtomicUsize);

    impl Wake for CountWake {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn dropped_waiters_release_their_wakers_before_cancellation() {
        let token = CancellationToken::new();
        let counter = Arc::new(CountWake::default());
        let waker = Waker::from(counter.clone());
        for _ in 0..1000 {
            let mut future = token.cancelled();
            assert!(
                Pin::new(&mut future)
                    .poll(&mut Context::from_waker(&waker))
                    .is_pending()
            );
            drop(future);
        }
        assert!(lock(&token.inner.wakers).is_empty());
        assert_eq!(Arc::strong_count(&counter), 2);
        token.cancel();
        assert_eq!(counter.0.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn repoll_replaces_the_waker_and_clones_register_independently() {
        let token = CancellationToken::new();
        let old = Arc::new(CountWake::default());
        let current = Arc::new(CountWake::default());
        let old_waker = Waker::from(old.clone());
        let current_waker = Waker::from(current.clone());
        let mut future = token.cancelled();
        assert!(
            Pin::new(&mut future)
                .poll(&mut Context::from_waker(&old_waker))
                .is_pending()
        );
        assert!(
            Pin::new(&mut future)
                .poll(&mut Context::from_waker(&current_waker))
                .is_pending()
        );
        assert_eq!(lock(&token.inner.wakers).len(), 1);
        let mut other = future.clone();
        assert!(
            Pin::new(&mut other)
                .poll(&mut Context::from_waker(&current_waker))
                .is_pending()
        );
        drop(future);
        assert_eq!(lock(&token.inner.wakers).len(), 1);
        token.cancel();
        assert_eq!(old.0.load(Ordering::SeqCst), 0);
        assert_eq!(current.0.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn wake_callbacks_can_reenter_the_waiter_registry() {
        struct Reentrant(CancellationToken);
        impl Wake for Reentrant {
            fn wake(self: Arc<Self>) {
                assert!(self.0.inner.wakers.try_lock().is_ok());
            }
        }
        let token = CancellationToken::new();
        let waker = Waker::from(Arc::new(Reentrant(token.clone())));
        let mut future = token.cancelled();
        assert!(
            Pin::new(&mut future)
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        token.cancel();
    }

    #[test]
    fn cancel_is_visible_through_clones() {
        let token = CancellationToken::new();
        let clone = token.clone();
        assert!(!clone.is_cancelled());
        token.cancel();
        assert!(clone.is_cancelled());
    }

    #[tokio::test]
    async fn cancelled_future_resolves() {
        let token = CancellationToken::new();
        let waiter = token.clone();
        let handle = tokio::spawn(async move { waiter.cancelled().await });
        token.cancel();
        handle.await.expect("waiter task panicked");
    }

    #[tokio::test]
    async fn cancelled_future_is_ready_when_already_cancelled() {
        let token = CancellationToken::new();
        token.cancel();
        token.cancelled().await;
    }
}
