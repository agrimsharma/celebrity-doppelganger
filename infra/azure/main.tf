data "azurerm_client_config" "current" {}

resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

locals {
  compact = "${var.name}${random_string.suffix.result}" # for globally unique, dash-free names
}

resource "azurerm_resource_group" "main" {
  name     = "${var.name}-rg"
  location = var.location
}

# --- Kubernetes -------------------------------------------------------------------------------

resource "azurerm_kubernetes_cluster" "main" {
  name                = "${var.name}-aks"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  dns_prefix          = var.name
  sku_tier            = "Free" # no control-plane fee

  default_node_pool {
    name                        = "default"
    vm_size                     = var.node_size
    node_count                  = var.node_count
    os_disk_size_gb             = 64
    temporary_name_for_rotation = "tmp"
  }

  identity {
    type = "SystemAssigned"
  }

  # workload identity: pods exchange a Kubernetes service-account token for an Entra token
  oidc_issuer_enabled       = true
  workload_identity_enabled = true
}

# --- container registry -------------------------------------------------------------------------

resource "azurerm_container_registry" "main" {
  name                = "${local.compact}acr"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Basic"
}

resource "azurerm_role_assignment" "aks_pulls_images" {
  scope                            = azurerm_container_registry.main.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_kubernetes_cluster.main.kubelet_identity[0].object_id
  skip_service_principal_aad_check = true
}

# --- private index storage (IMDB-WIKI is academic-use only: never public) -----------------------

resource "azurerm_storage_account" "index" {
  name                            = "${local.compact}idx"
  resource_group_name             = azurerm_resource_group.main.name
  location                        = azurerm_resource_group.main.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false # Entra ID auth only
  min_tls_version                 = "TLS1_2"
}

resource "azurerm_storage_container" "index" {
  name                  = "index"
  storage_account_id    = azurerm_storage_account.index.id
  container_access_type = "private"
}

# you (whoever runs terraform) upload the index with `az storage blob upload-batch --auth-mode login`
resource "azurerm_role_assignment" "operator_writes_index" {
  scope                = azurerm_storage_account.index.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}

# the backend pod reads it as this managed identity, via workload identity federation
resource "azurerm_user_assigned_identity" "dopp_backend" {
  name                = "${var.name}-dopp-backend"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
}

resource "azurerm_role_assignment" "backend_reads_index" {
  scope                = azurerm_storage_container.index.id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_user_assigned_identity.dopp_backend.principal_id
}

resource "azurerm_federated_identity_credential" "dopp_backend" {
  name                = "dopp-backend-k8s"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = azurerm_user_assigned_identity.dopp_backend.id
  issuer              = azurerm_kubernetes_cluster.main.oidc_issuer_url
  subject             = "system:serviceaccount:${var.dopp_namespace}:${var.dopp_service_account}"
  audience            = ["api://AzureADTokenExchange"]
}

# --- cost guard ---------------------------------------------------------------------------------

resource "azurerm_consumption_budget_resource_group" "main" {
  name              = "${var.name}-budget"
  resource_group_id = azurerm_resource_group.main.id
  amount            = var.budget_amount
  time_grain        = "Monthly"

  time_period {
    start_date = formatdate("YYYY-MM-01'T'00:00:00Z", timestamp())
  }

  notification {
    enabled        = true
    operator       = "GreaterThan"
    threshold      = 25
    threshold_type = "Actual"
    contact_emails = [var.alert_email]
  }
  notification {
    enabled        = true
    operator       = "GreaterThan"
    threshold      = 80
    threshold_type = "Forecasted"
    contact_emails = [var.alert_email]
  }

  lifecycle {
    ignore_changes = [time_period] # timestamp() would otherwise diff on every plan
  }
}
