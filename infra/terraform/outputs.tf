output "get_credentials" {
  description = "Point kubectl at the cluster."
  value       = "gcloud container clusters get-credentials ${google_container_cluster.main.name} --zone ${var.zone} --project ${var.project_id}"
}

output "image_repository" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}/backend"
}

output "index_bucket" {
  value = google_storage_bucket.index.name
}

output "backend_gcp_service_account" {
  value = google_service_account.backend.email
}

output "ingress_ip_name" {
  value = google_compute_global_address.ingress.name
}

output "ingress_ip" {
  description = "Set the frontend's BACKEND_URL to http://<this>/match"
  value       = google_compute_global_address.ingress.address
}
