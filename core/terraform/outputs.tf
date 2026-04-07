output "vm_name" {
  description = "Name of the VM instance"
  value       = google_compute_instance.vm.name
}

output "zone" {
  description = "Zone of the VM"
  value       = var.zone
}

output "project_id" {
  description = "GCP project ID"
  value       = var.project_id
}

output "ssh_command" {
  description = "Command to SSH into the VM via IAP"
  value       = "gcloud compute ssh ${var.vm_name} --zone=${var.zone} --project=${var.project_id} --tunnel-through-iap"
}

output "tunnel_command" {
  description = "Command to open noVNC SSH tunnel via IAP"
  value       = "gcloud compute ssh ${var.vm_name} --zone=${var.zone} --project=${var.project_id} --tunnel-through-iap -- -L 8080:localhost:8080 -N"
}

output "novnc_url" {
  description = "noVNC URL (open after SSH tunnel is active)"
  value       = "http://localhost:8080"
}

output "iap_user" {
  description = "User granted IAP tunnel access"
  value       = data.google_client_openid_userinfo.me.email
}

output "vpc_name" {
  description = "Dedicated VPC network name"
  value       = google_compute_network.vpc.name
}

output "subnet_name" {
  description = "Subnet name"
  value       = google_compute_subnetwork.subnet.name
}

output "subnet_cidr" {
  description = "Subnet CIDR range"
  value       = google_compute_subnetwork.subnet.ip_cidr_range
}
