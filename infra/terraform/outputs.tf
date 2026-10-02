output "get_credentials" {
  description = "Point kubectl at the cluster."
  value       = "gcloud container clusters get-credentials ${google_container_cluster.main.name} --zone ${var.zone} --project ${var.project_id}"
}

output "project_id" {
  value = var.project_id
}

output "region" {
  value = var.region
}

output "zone" {
  value = var.zone
}

output "cluster_name" {
  value = google_container_cluster.main.name
}

output "registry" {
  description = "Artifact Registry path; images are <registry>/<name>:<tag>"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "index_bucket" {
  value = google_storage_bucket.index.name
}

output "backend_gcp_service_account" {
  description = "Goes into the backend ServiceAccount annotation iam.gke.io/gcp-service-account"
  value       = google_service_account.backend.email
}

output "builder_service_account" {
  value = google_service_account.builder.email
}

output "github_wif_provider" {
  value = local.cicd ? google_iam_workload_identity_pool_provider.github[0].name : ""
}

output "github_deployer_service_account" {
  value = local.cicd ? google_service_account.deployer[0].email : ""
}
