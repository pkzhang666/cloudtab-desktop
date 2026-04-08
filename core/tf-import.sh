#!/usr/bin/env bash
set -euo pipefail

# Generic helper to import API enablement resources into Terraform state.
# Usage:
#   ./tf-import.sh <PROJECT_ID> [TERRAFORM_DIR]
# Example:
#   ./tf-import.sh my-gcp-project ./terraform

PROJECT_ID="${1:-}"
TF_DIR="${2:-$(cd "$(dirname "$0")/terraform" && pwd)}"

if [ -z "$PROJECT_ID" ]; then
	echo "Usage: $0 <PROJECT_ID> [TERRAFORM_DIR]" >&2
	exit 1
fi

if [ ! -d "$TF_DIR" ]; then
	echo "Terraform directory not found: $TF_DIR" >&2
	exit 1
fi

if ! command -v terraform >/dev/null 2>&1; then
	echo "terraform not found in PATH" >&2
	exit 1
fi

cd "$TF_DIR"

terraform import -lock=false 'google_project_service.apis["compute.googleapis.com"]' "$PROJECT_ID/compute.googleapis.com"
terraform import -lock=false 'google_project_service.apis["iam.googleapis.com"]' "$PROJECT_ID/iam.googleapis.com"
terraform import -lock=false 'google_project_service.apis["iap.googleapis.com"]' "$PROJECT_ID/iap.googleapis.com"
terraform import -lock=false 'google_project_service.apis["cloudresourcemanager.googleapis.com"]' "$PROJECT_ID/cloudresourcemanager.googleapis.com"

echo "ALL IMPORTS DONE"
