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
  default     = "doppelganger"
}

variable "machine_type" {
  description = "Node machine type. e2-standard-2 (2 vCPU / 8 GB) fits one backend pod (~1.5 GB: 140K-face index + ArcFace model) plus GKE system pods."
  type        = string
  default     = "e2-standard-2"
}

variable "node_count" {
  type    = number
  default = 1
}

variable "spot_nodes" {
  description = "Spot VMs cost ~60-90% less but can be preempted (the pod reschedules in ~1-2 min). Fine for a portfolio demo."
  type        = bool
  default     = true
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
