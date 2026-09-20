"""Multiplex plain TCP and TLS on one public port by peeking at the first
byte: a TLS ClientHello record starts with 0x16, while HTTP/WS/RFB traffic
starts with an ASCII character.

The agent API (:8000) and the noVNC stream (:6080) stay reachable over both
transports this way — TLS works anywhere the plain ports already reach, so
deployments don't need extra firewall rules or port forwards for :8443
and :6443 (those listeners still exist for older clients).
"""
import asyncio

TLS_RECORD_HANDSHAKE = 0x16


async def pipe(reader: asyncio.StreamReader,
                writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass


async def _route(client_r: asyncio.StreamReader,
                 client_w: asyncio.StreamWriter,
                 tls_port: int, plain_port: int) -> None:
    try:
        first = await client_r.read(1)
        if not first:
            return
        target = tls_port if first[0] == TLS_RECORD_HANDSHAKE else plain_port
        local_r, local_w = await asyncio.open_connection("127.0.0.1", target)
        local_w.write(first)
        await local_w.drain()
        await asyncio.gather(pipe(client_r, local_w),
                             pipe(local_r, client_w))
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            client_w.close()
        except OSError:
            pass


async def start_mux(public_port: int, tls_port: int, plain_port: int,
                    host: str = "0.0.0.0") -> asyncio.AbstractServer:
    """Listen on `public_port`; forward each connection to 127.0.0.1's
    `tls_port` when it opens with a TLS handshake, else `plain_port`."""
    srv = await asyncio.start_server(
        lambda r, w: _route(r, w, tls_port, plain_port),
        host, public_port)
    print(f"[gut] mux on :{public_port} "
          f"(tls -> :{tls_port}, plain -> :{plain_port})")
    return srv
