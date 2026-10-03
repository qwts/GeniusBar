//! The owner's consent for owner operations, asked by keyd itself: the macOS
//! device-owner prompt (Touch ID, a watch, or the login password) with
//! keyd's own description of the action. Nothing the caller presents can
//! stand in for it, so a soul that reaches the owner socket still needs a
//! person at the Mac.

pub trait Consent: Send + Sync {
    fn ask(&self, reason: &str) -> Result<(), String>;
}

#[cfg(target_os = "macos")]
pub struct DeviceOwner;

#[cfg(target_os = "macos")]
impl Consent for DeviceOwner {
    fn ask(&self, reason: &str) -> Result<(), String> {
        use block2::RcBlock;
        use objc2::runtime::Bool;
        use objc2_foundation::{NSError, NSString};
        use objc2_local_authentication::{LAContext, LAPolicy};
        use std::sync::mpsc;
        use std::time::Duration;

        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        // SAFETY: LAContext is created and used on this thread; the reply
        // block is Send (it only sends on a channel).
        unsafe {
            let context = LAContext::new();
            let reply = RcBlock::new(move |success: Bool, error: *mut NSError| {
                let outcome = if success.as_bool() {
                    Ok(())
                } else if error.is_null() {
                    Err("the owner did not approve".to_owned())
                } else {
                    Err(format!("the owner did not approve ({})", (*error).code()))
                };
                let _ = tx.send(outcome);
            });
            context.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthentication,
                &NSString::from_str(reason),
                &reply,
            );
            rx.recv_timeout(Duration::from_secs(120))
                .unwrap_or_else(|_| Err("the owner did not answer in time".to_owned()))
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::Consent;
    use std::sync::Mutex;

    /// Answers from a script and records what it was asked.
    pub struct Scripted {
        pub approve: bool,
        pub asked: Mutex<Vec<String>>,
    }

    impl Scripted {
        pub fn new(approve: bool) -> Self {
            Self {
                approve,
                asked: Mutex::default(),
            }
        }
    }

    impl Consent for Scripted {
        fn ask(&self, reason: &str) -> Result<(), String> {
            self.asked.lock().unwrap().push(reason.to_owned());
            if self.approve {
                Ok(())
            } else {
                Err("the owner did not approve".into())
            }
        }
    }

    /// Shared, so a test can read what keyd asked after handing it over.
    impl Consent for std::sync::Arc<Scripted> {
        fn ask(&self, reason: &str) -> Result<(), String> {
            self.as_ref().ask(reason)
        }
    }
}
