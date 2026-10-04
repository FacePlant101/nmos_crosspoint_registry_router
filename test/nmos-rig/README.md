# NMOS test rig

A registry and a virtual node from [nmos-cpp](https://github.com/sony/nmos-cpp),
for exercising the crosspoint against a third-party implementation instead of a
hand-written stub. Everything here is throwaway; nothing in it is needed at
runtime.

```bash
docker compose -f test/nmos-rig/docker-compose.yml up -d
```

The registry's query API is then on `http://127.0.0.1:8080/x-nmos/query/v1.3/`.

```bash
docker compose -f test/nmos-rig/docker-compose.yml down
```

## Pointing the crosspoint at it

Two ways, and the difference matters.

**From the host** — set `staticNmosRegistries` to `127.0.0.1:8080`. The
crosspoint will read the registry fine, but the node advertises its IS-05 and
manifest hrefs by *container* IP, so it cannot reach them. Good enough for
discovery, grouping and the matrix; not for anything that reads or writes a
sender's transport parameters.

**Inside the rig network** — build the image and join `nmosrig`, with
`staticNmosRegistries` set to `nmos-registry:8080`:

```bash
docker build -t nmos-crosspoint:rig .
docker run -d --name nmos-crosspoint-rig --network nmosrig -p 8099:80 \
  -v "$PWD/server/config:/nmos-crosspoint/server/config" \
  -v "$PWD/server/state:/nmos-crosspoint/server/state" \
  nmos-crosspoint:rig
```

Now the node's hrefs resolve, so IS-05 reads and PATCHes work. This is the mode
to use for multicast leases, duplicate detection and the SDP viewer.

## The image tag is pinned on purpose

`rhastie/nmos-cpp:latest` moves, and the node's sender transports moved with it.
That silently changes what this rig covers, so bump the tag deliberately and
re-check this table:

| Tag | Date | Node's senders |
|---|---|---|
| `master-0fb6b51` | 2023-03-08 | 8 RTP + websocket — **what this rig pins** |
| `master-079620d` | 2026-08-14 | MXL + websocket only, no RTP |
| `master-a19e364` / `latest` | 2026-08-21 | MXL + websocket only, no RTP |

The newer builds are not useless — an MXL-only node is a good adversarial case,
because MXL senders report `format: urn:x-nmos:format:video` while having no
multicast address at all. That combination is what exposed the bug fixed in
"Only lease multicast addresses to RTP senders". Switch tags deliberately to
test that path.

## What the pinned node gives you

With `how_many: 2`, ten senders: eight RTP (video, audio, data/ANC and
SMPTE 2022-6 mux) with real manifests and a working IS-05 connection API, plus
websocket event senders that should never receive multicast addresses.

The sender mix varies with `how_many` and takes up to ~45 s to finish
registering, so query after it settles rather than immediately after `up -d`.

## Known limits

- No RTP is actually transmitted. The node registers senders and serves IS-05,
  but nothing is on the wire, so the audio monitor cannot decode a real stream
  through this rig.
- `host_address` in `node.json` breaks sub-resource registration — the node
  registers but its devices and senders never appear. Leave it unset and join
  the network instead.
