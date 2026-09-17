# AG-UI Core Types

This repo contains the Rust types needed to work with the AG-UI protocol. Implemented using `serde` to support
(de)serialization. 

Contained are:

* [Message types](src/types/message.rs)
* [Event types](src/event.rs)
* [State trait bounds](src/state.rs)
* [Input types](src/types/input.rs)
* [Tool type](src/types/tool.rs)
* [Context type](src/types/context.rs)
* [ID (new)types](src/types/ids.rs)

Intended to be used with [`ag-ui-client`](../ag-ui-client). 