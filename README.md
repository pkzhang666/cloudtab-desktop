# CloudTab

> One-click secure remote Chrome browser on GCP — desktop app for Mac, Linux, and Windows.

CloudTab is an Electron desktop app that provisions a private GCP virtual machine running Google Chrome in a virtual desktop, accessible from your local machine through an encrypted [IAP tunnel](https://cloud.google.com/iap). No public IP. No VPN. No port forwarding.

Built on top of [novnc-chrome-desktop](https://github.com/pkzhang666/novnc-chrome-desktop).

---

## Why CloudTab?

- **Bypass geo-restrictions** — browse from a GCP region of your choice
- **Persistent sessions** — Chrome profile survives VM restarts
- **Zero public IP** — all traffic goes through Google's IAP, authenticated by your Google account
- **Cost-efficient** — pay only when the VM is running; stop it from the app when done
- **One binary** — no CLI, no config files, no terminal required

---

## Architecture

```
Your Machine
┌──────────────────────────────────────┐
│  CloudTab (Electron)                 │
│  ┌──────────┐   IAP SSH Tunnel       │
│  │ React UI │◄──localhost:8080───────┼──► Google IAP
│  └──────────┘                        │         │
│  ┌──────────┐                        │    GCP VPC (no public IP)
│  │  gcloud  │──── deploy/start/stop ─┼──► ┌──────────────────────┐
│  └──────────┘                        │    │  VM (e2-standard-2)  │
└──────────────────────────────────────┘    │  Docker              │
                                            │  ├── Xvfb (:99)      │
                                            │  ├── Fluxbox          │
                                            │  ├── Chrome           │
                                            │  ├── x11vnc           │
                                            │  └── noVNC (:8080)   │
                                            └──────────────────────┘
```

---

## Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) | Deploy & connect | `gcloud` CLI |
| [Terraform ≥ 1.5](https://developer.hashicorp.com/terraform/downloads) | Infrastructure | `terraform` |
| [Docker](https://docs.docker.com/get-docker/) | Build Chrome image | `docker` |
| **Windows only:** [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install) | Run bash scripts | `wsl --install` |

After installing gcloud, authenticate:

```bash
gcloud auth login
gcloud auth application-default login
```

---

## Quick Start

### 1. Download

Go to [Releases](https://github.com/pkzhang666/cloudtab-desktop/releases) and download the installer for your platform:

| Platform | File |
|----------|------|
| macOS    | `CloudTab-x.x.x.dmg` |
| Linux    | `CloudTab-x.x.x.AppImage` |
| Windows  | `CloudTab-Setup-x.x.x.exe` |

### 2. First launch

CloudTab walks you through a 3-step setup wizard:

1. **Prerequisites** — checks that gcloud, Terraform, and Docker are installed and authenticated
2. **GCP Config** — enter your project ID, region, machine type
3. **Security** — set a VNC password (min 8 characters) and screen resolution

### 3. Deploy

Click **Deploy VM** — CloudTab will:
- Create a dedicated VPC with Cloud NAT (no public IP)
- Provision a GCP Compute Engine VM
- Build and start the Chrome Docker container
- Auto-update Chrome if a newer version is available

### 4. Connect

Click **Connect** — CloudTab opens an IAP SSH tunnel and loads your Chrome session directly in the app window.

### 5. Done for the day?

Click **Stop VM** to shut down the instance. Your Chrome profile (cookies, history, extensions) is preserved in a Docker volume and resumes next time you start.

---

## Cost Estimate

All pricing is approximate, based on `us-central1`.

| Machine | vCPU | RAM | On-demand | Spot |
|---------|------|-----|-----------|------|
| e2-medium | 1 | 4 GB | ~$9/mo | ~$3/mo |
| e2-standard-2 *(default)* | 2 | 8 GB | ~$11/mo | ~$4/mo |
| e2-standard-4 | 4 | 16 GB | ~$19/mo | ~$7/mo |

You only pay while the VM is running. A typical 8h/day workday on e2-standard-2 costs around **$3–4/month**.

Additional costs: Cloud NAT (~$1/mo), egress traffic, 50 GB persistent disk (~$2/mo).

---

## Tab Capacity

Rough estimates for concurrent Chrome tabs (each tab ~150–300 MB RAM):

| Machine | RAM | Estimated tabs |
|---------|-----|---------------|
| e2-medium | 4 GB | 8–12 |
| e2-standard-2 | 8 GB | 18–25 |
| e2-standard-4 | 16 GB | 40–55 |

Video-heavy tabs (YouTube, Meet) use significantly more. If Chrome becomes unresponsive, stop the VM and upgrade the machine type in Settings.

---

## Development

```bash
git clone https://github.com/pkzhang666/cloudtab-desktop.git
cd cloudtab-desktop
npm install
```

### Run in dev mode (Linux/Mac)

```bash
unset ELECTRON_RUN_AS_NODE   # required if running inside VS Code terminal
npm run dev
```

> **Headless Linux (GCP VM):** Run `./dev-display.sh` first to start a virtual desktop (Xvfb + noVNC), then connect via browser and run `npm run dev` in the xterm.

### Build for distribution

```bash
npm run package:mac    # → release/CloudTab-x.x.x.dmg
npm run package:linux  # → release/CloudTab-x.x.x.AppImage
npm run package:win    # → release/CloudTab Setup x.x.x.exe  (run on Windows)
```

### App icons

Drop your icon files in `src/assets/` before packaging:

| File | Platform | Size |
|------|----------|------|
| `icon.icns` | macOS | 512×512 |
| `icon.png` | Linux | 512×512 |
| `icon.ico` | Windows | 256×256 |

---

## Project Structure

```
cloudtab-desktop/
├── electron/
│   ├── main.ts          # Main process — IPC handlers, VM control, tunnel
│   └── preload.ts       # contextBridge — exposes window.api to renderer
├── src/
│   ├── App.tsx          # Router — redirects to onboarding if unconfigured
│   ├── store.ts         # Zustand — vmStatus, tunnelStatus, logs
│   ├── pages/
│   │   ├── Onboarding.tsx   # 3-step setup wizard
│   │   ├── Dashboard.tsx    # VM status, Start/Stop/Connect buttons, logs
│   │   └── Settings.tsx     # Edit config, change password, destroy infra
│   └── index.css        # Tailwind v4
├── core/                # Bundled at build time (extraResources)
│   ├── docker/          # Dockerfile, supervisord.conf, entrypoint.sh
│   ├── scripts/         # setup.sh, ssh-tunnel.sh, check-chrome-update.sh
│   └── terraform/       # main.tf — VPC, VM, Cloud NAT, IAP firewall
├── dev-display.sh       # Virtual desktop for headless Linux development
└── electron.vite.config.ts
```

---

## Security

- **No public IP** — VM is on a private VPC, accessible only via Google IAP
- **IAP authentication** — every tunnel connection requires your Google identity
- **Firewall** — only IAP source range `35.235.240.0/20` allowed inbound
- **VNC password** — enforced minimum 8 characters, stored in local config only
- **contextIsolation** — renderer process has no direct Node.js access; all IPC goes through typed `window.api`

---

## Troubleshooting

**"Preload API not available"**
Run `unset ELECTRON_RUN_AS_NODE` before `npm run dev`. VS Code sets this environment variable which disables Electron's main process API.

**"IAP tunnel exited early"**
Make sure the VM is in RUNNING state before clicking Connect. If it just started, wait 30s for Docker to initialize.

**"Unable to access /tmp"**
On headless Linux, the Chromium sandbox may fail. This is handled automatically — the app disables the GPU sandbox on Linux.

**Blank screen / no UI**
Open DevTools (View → Toggle Developer Tools) and check the Console tab for errors.

**Chrome is slow / tabs crashing**
The VM is out of memory. Stop the VM, upgrade to a larger machine type in Settings, then Deploy again.

---

## License

MIT — see [LICENSE](LICENSE)
