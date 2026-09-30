terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # Local state by default. For anything beyond a solo demo, move it to GCS:
  # backend "gcs" {
  #   bucket = "<project>-tfstate"
  #   prefix = "doppelganger"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
