# CD: GitHub Actions (deploy-gke.yml in each repo) authenticates with Workload Identity
# Federation - a short-lived token GitHub signs for the repo. No service-account key exists.

locals {
  cicd = var.github_owner != ""
}

resource "google_iam_workload_identity_pool" "github" {
  count                     = local.cicd ? 1 : 0
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count                              = local.cicd ? 1 : 0
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  # only this owner's repos, only the main branch
  attribute_condition = "assertion.repository_owner == '${var.github_owner}' && assertion.ref == 'refs/heads/main'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "deployer" {
  count        = local.cicd ? 1 : 0
  account_id   = "${var.name}-deployer"
  display_name = "GitHub Actions: build images, roll out to GKE"
}

resource "google_project_iam_member" "deployer" {
  for_each = local.cicd ? toset([
    "roles/container.developer",      # helm upgrade inside the cluster
    "roles/cloudbuild.builds.editor", # submit image builds
    "roles/storage.admin",            # Cloud Build source upload bucket
    "roles/serviceusage.serviceUsageConsumer",
  ]) : toset([])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer[0].email}"
}

# builds run as the builder SA, so the deployer must be allowed to act as it
resource "google_service_account_iam_member" "deployer_uses_builder" {
  count              = local.cicd ? 1 : 0
  service_account_id = google_service_account.builder.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer[0].email}"
}

resource "google_service_account_iam_member" "github_impersonates_deployer" {
  for_each           = local.cicd ? toset(var.github_repos) : toset([])
  service_account_id = google_service_account.deployer[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository/${var.github_owner}/${each.value}"
}
