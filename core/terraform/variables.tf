variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone"
  type        = string
  default     = "us-central1-a"
}

variable "vm_name" {
  description = "Name of the Compute Engine instance"
  type        = string
  default     = "novnc-chrome"
}

variable "machine_type" {
  description = "Compute Engine machine type (e2-standard-2 = 2 vCPU / 8 GB)"
  type        = string
  default     = "e2-standard-2"
}

variable "disk_size_gb" {
  description = "Boot disk size in GB"
  type        = number
  default     = 50
}

variable "subnet_cidr" {
  description = "CIDR range for the dedicated subnet. Change if this conflicts with existing VPC peering."
  type        = string
  default     = "10.0.0.0/24"
}

variable "preemptible" {
  description = "Use a Spot VM — ~70% cheaper but may be reclaimed by GCP"
  type        = bool
  default     = false
}

variable "labels" {
  description = "Labels applied to all resources"
  type        = map(string)
  default = {
    project    = "novnc-chrome-desktop"
    managed-by = "terraform"
  }
}
