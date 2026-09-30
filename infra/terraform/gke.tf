resource "google_container_cluster" "main" {
  name     = var.name
  location = var.zone # zonal - see var.zone

  network    = google_compute_network.vpc.id
  subnetwork = google_compute_subnetwork.gke.id

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  release_channel {
    channel = "REGULAR"
  }

  # manage the node pool separately so it can be resized/replaced without touching the cluster
  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = false

  depends_on = [google_project_service.apis]
}

resource "google_service_account" "nodes" {
  account_id   = "${var.name}-nodes"
  display_name = "Doppelganger GKE nodes"
}

# minimal node permissions: pull images, write logs/metrics
resource "google_project_iam_member" "nodes" {
  for_each = toset([
    "roles/artifactregistry.reader",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.nodes.email}"
}

resource "google_container_node_pool" "default" {
  name       = "default"
  cluster    = google_container_cluster.main.id
  node_count = var.node_count

  node_config {
    machine_type    = var.machine_type
    spot            = var.spot_nodes
    disk_size_gb    = 50
    disk_type       = "pd-balanced"
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}
