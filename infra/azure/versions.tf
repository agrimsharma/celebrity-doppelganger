terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  # Local state: the whole environment lives for one recording session and is destroyed after.
}

provider "azurerm" {
  features {
    resource_group {
      prevent_deletion_if_contains_resources = false # down.sh must be able to remove everything
    }
  }
  subscription_id = var.subscription_id
}
