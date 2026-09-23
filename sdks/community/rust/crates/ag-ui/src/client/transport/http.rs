//! The `reqwest`-backed HTTP transport.
//!
//! One POST of the [`RunAgentInput`](crate::input::RunAgentInput) as JSON, one `text/event-stream` response
//! decoded by [`crate::client::transport::sse`]. This module is the only place in the
//! crate that pulls in an HTTP client, and it sits behind the `http` feature so
//! that a wasm or custom-transport build never sees it.

use futures_util::StreamExt;
use std::time::Duration;

use crate::{RunAgentInput, SSE_MEDIA_TYPE};
use reqwest::header::{ACCEPT, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Url};

use crate::client::error::{Error, Result};
use crate::client::transport::sse::decode_raw_events;
use crate::client::transport::{
    EventStream, RawEventStream, RawTransportFuture, Transport, TransportFuture,
};

/// Maximum number of response bytes retained before decoding an HTTP error body.
const MAX_ERROR_BODY: usize = 2048;

/// POSTs a run to an HTTP endpoint and streams the response.
#[derive(Clone, Debug)]
pub struct HttpTransport {
    client: Client,
    url: Url,
    headers: HeaderMap,
    timeout: Option<Duration>,
}

impl HttpTransport {
    /// A transport pointed at an agent's run endpoint, with default settings.
    ///
    /// # Errors
    ///
    /// [`Error::Config`] when the URL does not parse, or the HTTP client cannot
    /// be built.
    pub fn new(url: impl AsRef<str>) -> Result<Self> {
        Self::builder(url).build()
    }

    /// A builder, for headers, timeouts, or a pre-configured client.
    pub fn builder(url: impl AsRef<str>) -> HttpTransportBuilder {
        HttpTransportBuilder::new(url)
    }

    /// The endpoint this transport posts to.
    pub fn url(&self) -> &Url {
        &self.url
    }

    /// The headers sent with every run.
    pub fn headers(&self) -> &HeaderMap {
        &self.headers
    }
}

impl Transport for HttpTransport {
    fn run(&self, input: RunAgentInput) -> TransportFuture {
        let connecting = self.run_raw(input);
        Box::pin(async move {
            let raw = connecting.await?;
            Ok(Box::pin(crate::client::enforce::stream(raw)) as EventStream)
        })
    }

    fn run_raw(&self, input: RunAgentInput) -> RawTransportFuture {
        // Cloned rather than borrowed so the future outlives this call; see the
        // note on [`Transport`]. A `reqwest::Client` is an `Arc` inside.
        let client = self.client.clone();
        let url = self.url.clone();
        let headers = self.headers.clone();
        let timeout = self.timeout;

        Box::pin(async move {
            let mut request = client.post(url).headers(headers).json(&input);
            if let Some(timeout) = timeout {
                request = request.timeout(timeout);
            }

            let response = request.send().await.map_err(Error::transport)?;
            let status = response.status();
            if !status.is_success() {
                let mut stream = response.bytes_stream();
                let mut body = Vec::with_capacity(MAX_ERROR_BODY);
                while body.len() < MAX_ERROR_BODY {
                    let Some(Ok(chunk)) = stream.next().await else {
                        break;
                    };
                    let remaining = MAX_ERROR_BODY - body.len();
                    body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
                }
                return Err(Error::Http {
                    status: status.as_u16(),
                    body: String::from_utf8_lossy(&body).into_owned(),
                });
            }

            Ok(Box::pin(decode_raw_events(response.bytes_stream())) as RawEventStream)
        })
    }
}

/// Builds an [`HttpTransport`].
///
/// Header values are validated when [`HttpTransportBuilder::build`] is called,
/// so a chain of setters stays a chain and does not thread a `Result` through
/// every step.
#[derive(Clone, Debug)]
pub struct HttpTransportBuilder {
    url: String,
    headers: Vec<(String, String)>,
    timeout: Option<Duration>,
    connect_timeout: Option<Duration>,
    client: Option<Client>,
}

impl HttpTransportBuilder {
    /// A builder for an agent at `url`.
    pub fn new(url: impl AsRef<str>) -> Self {
        Self {
            url: url.as_ref().to_owned(),
            headers: Vec::new(),
            timeout: None,
            connect_timeout: None,
            client: None,
        }
    }

    /// Adds a header to every request — an API key, a tenant id, a trace
    /// header.
    #[must_use]
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// Adds several headers.
    #[must_use]
    pub fn headers<K, V>(mut self, headers: impl IntoIterator<Item = (K, V)>) -> Self
    where
        K: Into<String>,
        V: Into<String>,
    {
        self.headers
            .extend(headers.into_iter().map(|(k, v)| (k.into(), v.into())));
        self
    }

    /// Bounds the whole run: connecting, headers, *and* streaming the body.
    ///
    /// An agent that thinks for longer than this has its stream cut off, so a
    /// long-running agent wants [`HttpTransportBuilder::connect_timeout`]
    /// instead.
    #[must_use]
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Bounds only connection setup, leaving the stream itself unbounded.
    #[must_use]
    pub fn connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = Some(timeout);
        self
    }

    /// Uses a caller-supplied client, for proxies, custom TLS roots, or a
    /// connection pool shared with the rest of an application.
    #[must_use]
    pub fn client(mut self, client: Client) -> Self {
        self.client = Some(client);
        self
    }

    /// Builds the transport.
    ///
    /// # Errors
    ///
    /// [`Error::Config`] when the URL, a header name, or a header value is not
    /// valid, or when the HTTP client cannot be built.
    pub fn build(self) -> Result<HttpTransport> {
        let url = Url::parse(&self.url)
            .map_err(|error| Error::Config(format!("invalid URL {:?}: {error}", self.url)))?;

        let mut headers = HeaderMap::with_capacity(self.headers.len() + 1);
        headers.insert(ACCEPT, HeaderValue::from_static(SSE_MEDIA_TYPE));
        for (name, value) in self.headers {
            let name = HeaderName::try_from(name.as_str())
                .map_err(|error| Error::Config(format!("invalid header name {name:?}: {error}")))?;
            let value = HeaderValue::try_from(value.as_str()).map_err(|error| {
                Error::Config(format!("invalid value for header {name:?}: {error}"))
            })?;
            headers.insert(name, value);
        }

        let client = match self.client {
            Some(client) => client,
            None => {
                let mut builder = Client::builder();
                if let Some(timeout) = self.connect_timeout {
                    builder = builder.connect_timeout(timeout);
                }
                builder.build().map_err(|error| {
                    Error::Config(format!("could not build HTTP client: {error}"))
                })?
            }
        };

        Ok(HttpTransport {
            client,
            url,
            headers,
            timeout: self.timeout,
        })
    }
}
