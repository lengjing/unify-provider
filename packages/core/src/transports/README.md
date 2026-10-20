# Transports

A managed local endpoint is one possible editor integration route. Implement it only after confirming a target editor's native agent can use and automatically configure that endpoint.

The plugin owns service startup, loopback binding, local authentication, endpoint discovery, and shutdown. Users must not have to enter a URL, port, or key. Provider adapters remain independent of the HTTP compatibility layer.
