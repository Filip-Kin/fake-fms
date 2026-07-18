# Networking: the container at 10.0.100.5

Both FTA-Buddy and audience-display hardcode the FMS at `10.0.100.5`. The container owns that
address on the real field segment via a Docker **macvlan**. This is set up and live.

## Current setup (done)

- **UniFi:** the `Field` network already exists - **VLAN 3, `10.0.100.1/24`** (gateway is the UDM
  at `10.0.100.1`). The home server's switch port already trunks VLAN 3 (verified: tagging a test
  sub-interface and pinging `10.0.100.1` works).
- **Host VLAN interface:** a persistent NetworkManager VLAN connection provides the macvlan parent:

  ```bash
  sudo nmcli con add type vlan con-name fieldnet-vlan3 ifname enp14s0.3 dev enp14s0 id 3 \
    ipv4.method disabled ipv6.method ignore connection.autoconnect yes
  ```

  It has no host IP on purpose; it only needs to be up as the macvlan parent.
- **Container:** `docker compose up -d --build` creates the `fieldnet` macvlan (parent `enp14s0.3`,
  subnet `10.0.100.0/24`, gateway `10.0.100.1`) and pins the container to `10.0.100.5`.

  ```bash
  cd /media/nas/filip/ncdata/filip/files/Projects/fake-fms
  FIELDNET_PARENT=enp14s0.3 docker compose up -d --build
  ```

Reachable at `http://10.0.100.5:80` (FMS API + SignalR) and `http://10.0.100.5:3010` (control UI).

## Reachability

Inter-VLAN routing on the UDM means anything on the LAN reaches `10.0.100.5` via the gateway -
no need to join VLAN 3:

- **Home server** (Default VLAN): reaches `10.0.100.5` via the UDM (this sidesteps the usual
  macvlan same-host limitation because traffic egresses to the gateway and comes back on VLAN 3).
- **Laptop** (Default VLAN or Wi-Fi): reaches `10.0.100.5` the same way. Point your dev apps at it.
  If a future firewall rule isolates the Field VLAN, either add an allow rule or join VLAN 3.

## Verify

```bash
curl http://10.0.100.5/FieldMonitor                                            # 200 health page
curl http://10.0.100.5/api/v1.0/systembase/get/get_CurrentlyActiveEventCode    # "fake"
# full SignalR + REST + control check from anywhere on the LAN:
SMOKE_HOST=10.0.100.5 SMOKE_FMS_PORT=80 SMOKE_CONTROL_PORT=3010 bun run smoke
```

## Notes

- The container binds port 80 inside, so it runs as root (see Dockerfile). macvlan gives it its
  own MAC + IP, so there is no port-80 conflict with other home-server services.
- If audience-display is later run on the home server and needs to reach the FMS, either let it use
  the UDM-routed path above or attach it to the same `fieldnet` compose network.
