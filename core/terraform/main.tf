# ── Enable required APIs ──────────────────────────────────────────────────────
resource "google_project_service" "apis" {
  for_each = toset([
    "compute.googleapis.com",
    "iap.googleapis.com",
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ── Auto-grant IAP tunnel access to the deploying user ───────────────────────
data "google_client_openid_userinfo" "me" {
  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "iap_tunnel_user" {
  project = var.project_id
  role    = "roles/iap.tunnelResourceAccessor"
  member  = "user:${data.google_client_openid_userinfo.me.email}"
}

# ── Service account (minimal permissions) ────────────────────────────────────
resource "google_service_account" "vm" {
  account_id   = "${var.vm_name}-sa"
  display_name = "noVNC Chrome Desktop VM"
  depends_on   = [google_project_service.apis]
}

resource "google_project_iam_member" "vm_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.vm.email}"
}

# ── Dedicated VPC network ─────────────────────────────────────────────────────
# Never use the "default" network — it may not exist (best practice is to
# delete it) and its auto-created firewall rules are too permissive.
resource "google_compute_network" "vpc" {
  name                    = "${var.vm_name}-vpc"
  auto_create_subnetworks = false   # we create subnets explicitly
  routing_mode            = "REGIONAL"

  depends_on = [google_project_service.apis]
}

# ── Subnet ────────────────────────────────────────────────────────────────────
resource "google_compute_subnetwork" "subnet" {
  name          = "${var.vm_name}-subnet"
  ip_cidr_range = var.subnet_cidr
  region        = var.region
  network       = google_compute_network.vpc.id

  # Allows the VM to reach Google APIs (Logging, IAP, etc.) without a public IP
  private_ip_google_access = true
}

# ── Cloud Router + NAT ────────────────────────────────────────────────────────
# The VM has no public IP, so all outbound internet traffic (apt, Docker Hub,
# Google Chrome apt repo, noVNC GitHub clone) must egress via Cloud NAT.
resource "google_compute_router" "router" {
  name    = "${var.vm_name}-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  name                               = "${var.vm_name}-nat"
  router                             = google_compute_router.router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = false
    filter = "ERRORS_ONLY"
  }
}

# ── Firewall: SSH via IAP only ────────────────────────────────────────────────
# IAP's fixed source range is 35.235.240.0/20 — no direct public SSH exposure.
# All other ingress is implicitly denied (no default-allow-internal rule here).
resource "google_compute_firewall" "iap_ssh" {
  name    = "${var.vm_name}-allow-iap-ssh"
  network = google_compute_network.vpc.id

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["35.235.240.0/20"]
  target_tags   = [var.vm_name]
  description   = "Allow SSH from Google IAP only"

  depends_on = [google_compute_network.vpc]
}

# ── Compute Engine VM (no public IP) ─────────────────────────────────────────
resource "google_compute_instance" "vm" {
  name         = var.vm_name
  machine_type = var.machine_type
  zone         = var.zone
  tags         = [var.vm_name]
  labels       = var.labels

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = var.disk_size_gb
      type  = "pd-ssd"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.subnet.id
    # No access_config block = no public IP; outbound goes via Cloud NAT
  }

  service_account {
    email = google_service_account.vm.email
    # Minimal scopes: logging-write for startup script logs only.
    # The VM does not call any other GCP APIs directly; IAP tunnel auth
    # is handled at the network level, not via the service account token.
    scopes = ["logging-write"]
  }

  scheduling {
    preemptible       = var.preemptible
    automatic_restart = var.preemptible ? false : true
  }

  # Startup script: install Docker on first boot
  metadata_startup_script = <<-SCRIPT
    #!/bin/bash
    set -e
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg lsb-release

    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
      > /etc/apt/sources.list.d/docker.list

    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin

    systemctl enable docker
    systemctl start docker

    mkdir -p /opt/novnc-chrome
    chmod 755 /opt/novnc-chrome

    echo "VM ready." >> /var/log/startup-script.log
  SCRIPT

  depends_on = [
    google_compute_router_nat.nat,   # NAT must be up before VM boots so startup script can reach the internet
    google_project_service.apis,
  ]
}
