variable "subscription_id" {
  description = "Azure subscription (the free account's subscription id: az account show --query id -o tsv)."
  type        = string
}

variable "location" {
  description = "North Europe = Dublin."
  type        = string
  default     = "northeurope"
}

variable "name" {
  description = "Prefix for resource names (lowercase letters/digits)."
  type        = string
  default     = "portfolio"
}

variable "node_size" {
  description = "2 vCPU / 8 GB burstable. Free-trial subscriptions usually allow 4 vCPUs per region, i.e. two of these."
  type        = string
  default     = "Standard_B2s_v2"
}

variable "node_count" {
  type    = number
  default = 2
}

variable "budget_amount" {
  description = "Monthly budget (USD) for the resource group - an extra alert on top of the free account's spending limit."
  type        = number
  default     = 20
}

variable "alert_email" {
  description = "Where budget alerts go."
  type        = string
}

variable "dopp_namespace" {
  type    = string
  default = "doppelganger"
}

variable "dopp_service_account" {
  type    = string
  default = "doppelganger-backend"
}

variable "github_owner" {
  description = "GitHub account whose repos may deploy to this cluster via OIDC (empty = no CI/CD identity)."
  type        = string
  default     = "agrimsharma"
}

variable "github_repos" {
  type    = list(string)
  default = ["celebrity-doppelganger", "saas-churn-platform"]
}
