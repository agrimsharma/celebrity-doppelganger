locals {
  services = [
    "container.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "storage.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "compute.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}

# --- network ------------------------------------------------------------------------------

resource "google_compute_network" "vpc" {
  name                    = "${var.name}-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "gke" {
  name          = "${var.name}-gke"
  region        = var.region
  network       = google_compute_network.vpc.id
  ip_cidr_range = "10.10.0.0/20"

  # VPC-native cluster: pods and services get alias IP ranges, which container-native
  # load balancing (NEGs) for the GCE Ingress requires
  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.20.0.0/16"
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.30.0.0/20"
  }
}

# --- container registry + index bucket ---------------------------------------------------

resource "google_artifact_registry_repository" "images" {
  repository_id = var.name
  location      = var.region
  format        = "DOCKER"
  description   = "Doppelganger backend images"
  depends_on    = [google_project_service.apis]

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }
}

# Private: IMDB-WIKI is licensed for academic use, so the index is never public -
# only the backend pod's service account can read it.
resource "google_storage_bucket" "index" {
  name                        = "${var.project_id}-${var.name}-index"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  depends_on                  = [google_project_service.apis]
}

# --- workload identity: pod -> GCP service account -> bucket read -----------------------

resource "google_service_account" "backend" {
  account_id   = "${var.name}-backend"
  display_name = "Doppelganger backend (reads index bucket)"
}

resource "google_storage_bucket_iam_member" "backend_reads_index" {
  bucket = google_storage_bucket.index.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.backend.email}"
}

resource "google_service_account_iam_member" "workload_identity" {
  service_account_id = google_service_account.backend.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${var.k8s_namespace}/${var.k8s_service_account}]"
  depends_on         = [google_container_cluster.main]
}

# --- image builds (Cloud Build, remote amd64 - nothing is cross-compiled locally) ----------------

resource "google_service_account" "builder" {
  account_id   = "${var.name}-builder"
  display_name = "Cloud Build: builds images into Artifact Registry"
}

resource "google_project_iam_member" "builder" {
  for_each = toset([
    "roles/artifactregistry.writer",
    "roles/logging.logWriter",
    "roles/storage.objectAdmin", # read the uploaded build source, write build logs
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.builder.email}"
}
