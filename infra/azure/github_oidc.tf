# CI/CD: GitHub Actions (deploy-aks.yml in each repo) logs in to Azure with OIDC - a short-lived
# token GitHub signs for that repo's main branch. No client secret exists anywhere.

locals {
  cicd = var.github_owner != ""
}

resource "azuread_application" "github" {
  count        = local.cicd ? 1 : 0
  display_name = "${var.name}-github-actions"
}

resource "azuread_service_principal" "github" {
  count     = local.cicd ? 1 : 0
  client_id = azuread_application.github[0].client_id
}

resource "azuread_application_federated_identity_credential" "github" {
  for_each       = local.cicd ? toset(var.github_repos) : toset([])
  application_id = azuread_application.github[0].id
  display_name   = "github-${each.value}-main"
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = "repo:${var.github_owner}/${each.value}:ref:refs/heads/main"
  audiences      = ["api://AzureADTokenExchange"]
}

# scoped to this resource group only: build in ACR, fetch cluster credentials, nothing else
resource "azurerm_role_assignment" "github_deploys" {
  count                = local.cicd ? 1 : 0
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Contributor"
  principal_id         = azuread_service_principal.github[0].object_id
}
