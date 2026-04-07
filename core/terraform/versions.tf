terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # Uncomment to use GCS remote state (recommended for teams)
  # backend "gcs" {
  #   bucket = "your-tf-state-bucket"
  #   prefix = "novnc-chrome-desktop/state"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}
