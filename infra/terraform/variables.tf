variable "project_id" {
  description = "GCP project to deploy into."
  type        = string
}

variable "region" {
  description = "Region for the VPC subnet, registry and bucket."
  type        = string
  default     = "europe-west1"
}

variable "zone" {
  description = "Zone for the cluster. Must stay ZONAL: the GKE free-tier credit covers one zonal (or Autopilot) cluster's management fee, not a regional one."
  type        = string
  default     = "europe-west1-b"
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "portfolio"
}

variable "machine_type" {
  description = "Node machine type. 2x e2-standard-4 (4 vCPU / 16 GB) runs both projects + monitoring with headroom."
  type        = string
  default     = "e2-standard-4"
}

variable "node_count" {
  type    = number
  default = 2
}

variable "spot_nodes" {
  description = "Spot VMs cost ~60-90% less but Google can reclaim them at any time - off for a recording session."
  type        = bool
  default     = false
}

variable "k8s_namespace" {
  description = "Namespace the Helm release is installed into (used for the Workload Identity binding)."
  type        = string
  default     = "doppelganger"
}

variable "k8s_service_account" {
  description = "Kubernetes ServiceAccount name the Helm chart creates."
  type        = string
  default     = "doppelganger-backend"
}

variable "github_owner" {
  description = "GitHub account whose repos may deploy to this cluster via Workload Identity Federation (empty = no CD identity)."
  type        = string
  default     = "agrimsharma"
}

variable "github_repos" {
  type    = list(string)
  default = ["celebrity-doppelganger", "saas-churn-platform"]
}
