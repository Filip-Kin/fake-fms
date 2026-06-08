# Networking: getting the container to 10.0.100.5

Both FTA-Buddy and audience-display hardcode the FMS at `10.0.100.5`. The container must own
that address on a real `10.0.100.0/24` segment so the server and the laptop can both reach it.
The default `docker-compose.yml` uses a **macvlan** network for this.

## 1. UniFi: create the field VLAN

1. Settings -> Networks -> New Virtual Network.
   - Name: `Field` (VLAN 100, or any free VLAN id).
   - Subnet/Gateway: `10.0.100.1/24`.
2. Make sure the home server's switch port and the laptop's connection can carry VLAN 100
   (tagged on the server trunk; the laptop can use a VLAN-tagged interface or a dedicated SSID
   mapped to the Field network).

## 2. Host: VLAN sub-interface (macvlan parent)

The macvlan parent should be a VLAN sub-interface on the server's LAN NIC (`enp14s0`):

```bash
# one-off (non-persistent)
sudo ip link add link enp14s0 name enp14s0.100 type vlan id 100
sudo ip link set enp14s0.100 up
```

Persist it with your network manager (systemd-networkd `.netdev`/`.network`, or
`nmcli con add type vlan ...`). Then bring the stack up:

```bash
FIELDNET_PARENT=enp14s0.100 docker compose up -d --build
```

The container is now reachable at `http://10.0.100.5:80` (FMS) and `http://10.0.100.5:3010`
(control UI) from anything on VLAN 100.

## 3. Host-to-container reachability (macvlan caveat)

A macvlan container cannot be reached from its own Docker host by default. Two options:

- **Preferred:** run the consumer that lives on this server (audience-display) attached to the
  same `fieldnet` network so it talks to `10.0.100.5` directly over the macvlan.
- **Shim:** give the host a macvlan interface on the same VLAN with a route to the container:

  ```bash
  sudo ip link add fieldnet-shim link enp14s0.100 type macvlan mode bridge
  sudo ip addr add 10.0.100.2/24 dev fieldnet-shim
  sudo ip link set fieldnet-shim up
  sudo ip route add 10.0.100.5/32 dev fieldnet-shim
  ```

## 4. Laptop access

- If the laptop is on VLAN 100, it reaches `10.0.100.5` natively.
- Otherwise add a static route to the field subnet via the UDM:
  `10.0.100.0/24` via your UDM's address on the laptop's normal LAN.

## 5. Verify

```bash
curl http://10.0.100.5/FieldMonitor          # -> 200 health page
curl http://10.0.100.5/api/v1.0/systembase/get/get_CurrentlyActiveEventCode
```

## Fallback: host networking (only if host port 80 is free)

If you do not want a VLAN, you can run with host networking and assign the IP to the host NIC.
Note the home server already uses port 80 for other services, so this will usually conflict;
prefer macvlan.

```bash
sudo ip addr add 10.0.100.5/24 dev enp14s0
docker run --network host -e FMS_PORT=80 -e CONTROL_PORT=3010 fake-fms
```
