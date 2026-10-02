output "reader_url" {
  description = "Web UI の URL"
  value       = "https://${var.reader_hostname}/"
}

output "admin_username" {
  value = var.admin_username
}

output "admin_password" {
  description = "初回ログイン用。ログイン後にパスキー登録・TOTP 設定を推奨"
  value       = random_password.admin.result
  sensitive   = true
}

output "ifttt_webhook_url" {
  description = "IFTTT の Webhooks アクションに設定する URL（terraform output -raw ifttt_webhook_url）"
  value       = "https://${var.reader_hostname}/hook/x/${random_password.webhook_token.result}"
  sensitive   = true
}

output "instance_id" {
  value = module.oci.instance_id
}

output "instance_public_ip" {
  description = "受信ポートは全閉のため、通常は直接アクセスしない"
  value       = module.oci.instance_public_ip
}

output "backup_bucket" {
  value = module.oci.backup_bucket_name
}
