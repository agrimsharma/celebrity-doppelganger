output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "get_credentials" {
  value = "az aks get-credentials -g ${azurerm_resource_group.main.name} -n ${azurerm_kubernetes_cluster.main.name} --overwrite-existing"
}

output "acr_login_server" {
  value = azurerm_container_registry.main.login_server
}

output "acr_name" {
  value = azurerm_container_registry.main.name
}

output "storage_account" {
  value = azurerm_storage_account.index.name
}

output "dopp_backend_client_id" {
  description = "Goes into the backend ServiceAccount annotation azure.workload.identity/client-id"
  value       = azurerm_user_assigned_identity.dopp_backend.client_id
}

output "alert_email" {
  value = var.alert_email
}
