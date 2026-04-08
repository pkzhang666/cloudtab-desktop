# =============================================================================
# noVNC Chrome Desktop — Makefile
# =============================================================================
# Quick reference:
#   make setup      — first-time config (reads .env, writes terraform.tfvars)
#   make deploy     — provision VM + push files + start container
#   make tunnel     — open noVNC in browser via IAP; auto-stops VM on exit
#   make vm-start   — start a stopped VM
#   make vm-stop    — stop the VM (keeps disk)
#   make status     — show VM state and access info
# =============================================================================

BLUE  := \033[36m
GREEN := \033[32m
YELLOW:= \033[33m
RED   := \033[31m
BOLD  := \033[1m
NC    := \033[0m

# ── Load .env ─────────────────────────────────────────────────────────────────
-include .env
export

# ── Terraform-derived variables ───────────────────────────────────────────────
TF_DIR := terraform

_tf_out = $(shell cd $(TF_DIR) && terraform output -raw $(1) 2>/dev/null || echo "")

VM_NAME    := $(or $(call _tf_out,vm_name),   $(VM_NAME),   novnc-chrome)
ZONE       := $(or $(call _tf_out,zone),       $(ZONE),       us-central1-a)
PROJECT_ID := $(or $(call _tf_out,project_id), $(PROJECT_ID), \
                $(shell gcloud config get-value project 2>/dev/null))

DOCKER_COMPOSE := $(shell docker compose version >/dev/null 2>&1 \
                    && echo "docker compose" || echo "docker-compose")

REMOTE_DIR := /opt/novnc-chrome

.DEFAULT_GOAL := help

# =============================================================================
# HELP
# =============================================================================
.PHONY: help
help:
	@printf "\n$(BOLD)noVNC Chrome Desktop$(NC)\n\n"
	@printf "$(YELLOW)First time:$(NC)\n"
	@printf "  $(BLUE)make setup$(NC)      Edit .env, then run this to generate terraform.tfvars + init Terraform\n"
	@printf "  $(BLUE)make deploy$(NC)     Provision GCP VM, push files, start container\n\n"
	@printf "$(YELLOW)Daily use:$(NC)\n"
	@printf "  $(BLUE)make tunnel$(NC)     Open noVNC via IAP tunnel; auto-stops VM when you disconnect\n"
	@printf "  $(BLUE)make vm-start$(NC)   Start a stopped VM\n"
	@printf "  $(BLUE)make vm-stop$(NC)    Stop the VM (disk preserved)\n"
	@printf "  $(BLUE)make status$(NC)     Show VM state and access info\n\n"
	@printf "$(YELLOW)Terraform:$(NC)\n"
	@printf "  $(BLUE)make tf-plan$(NC)    Preview infrastructure changes\n"
	@printf "  $(BLUE)make tf-apply$(NC)   Apply infrastructure changes\n"
	@printf "  $(BLUE)make tf-destroy$(NC) Destroy all GCP resources\n\n"
	@printf "$(YELLOW)Local dev:$(NC)\n"
	@printf "  $(BLUE)make build$(NC)      Build Docker image locally\n"
	@printf "  $(BLUE)make up$(NC)         Start stack locally (no VM needed)\n"
	@printf "  $(BLUE)make down$(NC)       Stop local stack\n"
	@printf "  $(BLUE)make logs$(NC)       Stream local Docker logs\n\n"
	@printf "$(YELLOW)Utilities:$(NC)\n"
	@printf "  $(BLUE)make check$(NC)      Verify prerequisites\n"
	@printf "  $(BLUE)make push$(NC)       Re-sync files to VM + restart stack\n\n"

# =============================================================================
# PREREQUISITES
# =============================================================================

# Internal guard — hard-fails if VNC_PASSWORD is still the placeholder.
# Depended on by build, up, and push so the image can never be deployed
# with the default password.
.PHONY: _check_vnc_password
_check_vnc_password:
	@VNC_PWD=$$(grep -E '^VNC_PASSWORD=' .env 2>/dev/null \
		| cut -d'=' -f2- | tr -d '"' | tr -d "'" | xargs 2>/dev/null); \
	if [ -z "$$VNC_PWD" ] || [ "$$VNC_PWD" = "changeme" ]; then \
		printf "$(RED)ERROR: VNC_PASSWORD is still the default 'changeme'.$(NC)\n"; \
		printf "$(RED)       Edit .env and set a real password, then retry.$(NC)\n"; \
		exit 1; \
	fi; \
	if [ $${#VNC_PWD} -lt 8 ]; then \
		printf "$(RED)ERROR: VNC_PASSWORD must be at least 8 characters.$(NC)\n"; \
		exit 1; \
	fi

.PHONY: check
check:
	@printf "$(BLUE)==> Checking prerequisites...$(NC)\n"
	@command -v terraform >/dev/null 2>&1 \
		&& printf "  $(GREEN)✓$(NC) terraform\n" \
		|| { printf "  $(RED)✗ terraform not found$(NC)\n"; exit 1; }
	@command -v gcloud >/dev/null 2>&1 \
		&& printf "  $(GREEN)✓$(NC) gcloud\n" \
		|| { printf "  $(RED)✗ gcloud not found$(NC)\n"; exit 1; }
	@gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q . \
		&& printf "  $(GREEN)✓$(NC) gcloud user: $$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)\n" \
		|| { printf "  $(RED)✗ not logged in — run: gcloud auth login$(NC)\n"; exit 1; }
	@gcloud auth application-default print-access-token >/dev/null 2>&1 \
		&& printf "  $(GREEN)✓$(NC) application-default credentials\n" \
		|| { printf "  $(RED)✗ no ADC — run: gcloud auth application-default login$(NC)\n"; exit 1; }
	@command -v docker >/dev/null 2>&1 \
		&& printf "  $(GREEN)✓$(NC) docker\n" \
		|| { printf "  $(RED)✗ docker not found$(NC)\n"; exit 1; }
	@test -f .env \
		&& printf "  $(GREEN)✓$(NC) .env\n" \
		|| printf "  $(YELLOW)⚠ .env missing — run: make setup$(NC)\n"
	@test -f $(TF_DIR)/terraform.tfvars \
		&& printf "  $(GREEN)✓$(NC) terraform.tfvars\n" \
		|| printf "  $(YELLOW)⚠ terraform.tfvars missing — run: make setup$(NC)\n"
	@VNC_PWD=$$(grep -E '^VNC_PASSWORD=' .env 2>/dev/null \
		| cut -d'=' -f2- | tr -d '"' | tr -d "'" | xargs 2>/dev/null); \
	if [ -z "$$VNC_PWD" ] || [ "$$VNC_PWD" = "changeme" ]; then \
		printf "  $(RED)✗ VNC_PASSWORD is still 'changeme' — edit .env$(NC)\n"; \
	else \
		printf "  $(GREEN)✓$(NC) VNC_PASSWORD set\n"; \
	fi
	@printf "$(GREEN)==> Done.$(NC)\n"

# =============================================================================
# SETUP (first-time)
# =============================================================================
.PHONY: setup
setup:
	@printf "$(BLUE)==> Running first-time setup...$(NC)\n"
	@bash scripts/setup.sh

# =============================================================================
# TERRAFORM
# =============================================================================
.PHONY: tf-init
tf-init:
	cd $(TF_DIR) && terraform init -upgrade

.PHONY: tf-apis
tf-apis: check
	@printf "$(BLUE)==> Enabling GCP APIs (compute, iap, iam, cloudresourcemanager)...$(NC)\n"
	cd $(TF_DIR) && terraform apply \
		-target='google_project_service.apis["compute.googleapis.com"]' \
		-target='google_project_service.apis["iap.googleapis.com"]' \
		-target='google_project_service.apis["iam.googleapis.com"]' \
		-target='google_project_service.apis["cloudresourcemanager.googleapis.com"]' \
		-auto-approve
	@printf "$(YELLOW)APIs enabled. Waiting 60s for propagation before next steps...$(NC)\n"
	@for i in $$(seq 60 -1 1); do printf "\r  %2ds remaining...  " $$i; sleep 1; done
	@printf "\r                         \r"
	@printf "$(GREEN)==> APIs ready.$(NC)\n"

.PHONY: tf-plan
tf-plan:
	cd $(TF_DIR) && terraform plan

.PHONY: tf-apply
tf-apply: check
	@printf "$(BLUE)==> Provisioning infrastructure...$(NC)\n"
	cd $(TF_DIR) && terraform apply -auto-approve
	@printf "$(GREEN)==> VM provisioned.$(NC)\n"
	@$(MAKE) status

.PHONY: tf-destroy
tf-destroy:
	@printf "$(RED)==> WARNING: This will destroy the VM and all resources.$(NC)\n"
	@printf "$(RED)   Waiting 5 seconds — Ctrl+C to cancel...$(NC)\n"
	@sleep 5
	cd $(TF_DIR) && terraform destroy -auto-approve

# =============================================================================
# DEPLOYMENT
# =============================================================================
.PHONY: deploy
deploy: tf-apply push
	@printf "$(GREEN)$(BOLD)==> Deployment complete!$(NC)\n"
	@$(MAKE) status

.PHONY: push
push: _check_vnc_password
	@if [ -z "$(PROJECT_ID)" ]; then \
		printf "$(RED)ERROR: PROJECT_ID not set. Run 'make setup' first.$(NC)\n"; exit 1; \
	fi
	@printf "$(BLUE)==> Verifying VM is ready...$(NC)\n"
	gcloud compute ssh $(VM_NAME) \
		--zone=$(ZONE) --project=$(PROJECT_ID) --tunnel-through-iap \
		--command="bash -s" < scripts/vm-setup.sh
	@printf "$(BLUE)==> Syncing files to VM...$(NC)\n"
	gcloud compute scp --recurse --compress \
		docker-compose.yml docker/ .env \
		$(VM_NAME):$(REMOTE_DIR)/ \
		--zone=$(ZONE) --project=$(PROJECT_ID) --tunnel-through-iap
	@printf "$(BLUE)==> Starting Docker stack on VM...$(NC)\n"
	gcloud compute ssh $(VM_NAME) \
		--zone=$(ZONE) --project=$(PROJECT_ID) --tunnel-through-iap \
		--command="cd $(REMOTE_DIR) && sudo docker compose up -d --build"
	@printf "$(GREEN)==> Stack running. Run 'make tunnel' to connect.$(NC)\n"

# =============================================================================
# VM POWER MANAGEMENT
# =============================================================================
.PHONY: vm-start
vm-start:
	@printf "$(BLUE)==> Starting VM $(VM_NAME)...$(NC)\n"
	gcloud compute instances start $(VM_NAME) --zone=$(ZONE) --project=$(PROJECT_ID) --quiet
	@printf "$(GREEN)==> VM started. Run 'make tunnel' to connect.$(NC)\n"

.PHONY: vm-stop
vm-stop:
	@printf "$(BLUE)==> Stopping VM $(VM_NAME)...$(NC)\n"
	gcloud compute instances stop $(VM_NAME) --zone=$(ZONE) --project=$(PROJECT_ID) --quiet
	@printf "$(GREEN)==> VM stopped. Disk is preserved.$(NC)\n"

# =============================================================================
# LOCAL DEVELOPMENT
# =============================================================================
.PHONY: build
build: _check_vnc_password
	$(DOCKER_COMPOSE) build

.PHONY: up
up: _check_vnc_password
	$(DOCKER_COMPOSE) up -d
	@printf "$(GREEN)==> Stack started locally. Open http://localhost:8080$(NC)\n"

.PHONY: down
down:
	$(DOCKER_COMPOSE) down

.PHONY: logs
logs:
	$(DOCKER_COMPOSE) logs -f

# =============================================================================
# ACCESS
# =============================================================================
.PHONY: ssh
ssh:
	gcloud compute ssh $(VM_NAME) \
		--zone=$(ZONE) --project=$(PROJECT_ID) --tunnel-through-iap

.PHONY: tunnel
tunnel:
	@bash scripts/ssh-tunnel.sh $(VM_NAME) $(ZONE) $(PROJECT_ID)

# =============================================================================
# STATUS
# =============================================================================
.PHONY: status
status:
	@printf "\n$(BOLD)noVNC Chrome Desktop — Status$(NC)\n"
	@printf "────────────────────────────────────────\n"
	@if [ -n "$(PROJECT_ID)" ]; then \
		VM_STATUS=$$(gcloud compute instances describe $(VM_NAME) \
			--zone=$(ZONE) --project=$(PROJECT_ID) \
			--format="value(status)" 2>/dev/null || echo "NOT FOUND"); \
		printf "  VM name   : $(VM_NAME)\n"; \
		printf "  Zone      : $(ZONE)\n"; \
		printf "  Project   : $(PROJECT_ID)\n"; \
		if [ "$$VM_STATUS" = "RUNNING" ]; then \
			printf "  Status    : $(GREEN)$$VM_STATUS$(NC)\n"; \
		elif [ "$$VM_STATUS" = "TERMINATED" ] || [ "$$VM_STATUS" = "STOPPED" ]; then \
			printf "  Status    : $(YELLOW)$$VM_STATUS$(NC)\n"; \
		else \
			printf "  Status    : $(RED)$$VM_STATUS$(NC)\n"; \
		fi; \
		printf "\n  Connect   : $(BLUE)make tunnel$(NC)\n"; \
		printf "  Browser   : $(BLUE)http://localhost:8080$(NC) (after tunnel)\n"; \
	else \
		printf "  $(YELLOW)PROJECT_ID not set. Run 'make setup'.$(NC)\n"; \
	fi
	@printf "────────────────────────────────────────\n\n"
