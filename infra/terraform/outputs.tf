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

output "env_file" {
  description = "VM の /opt/freetier-reader/.env と同じ内容（設定変更を VM に反映するときに使う。docs/terraform.md）"
  value       = local.env_file
  sensitive   = true
}

output "instance_id" {
  value = module.oci.instance_id
}

output "instance_private_ip" {
  description = "Bastion のポートフォワーディングセッションの接続先"
  value       = module.oci.instance_private_ip
}

output "bastion_id" {
  value = module.oci.bastion_id
}

output "data_volume_id" {
  value = module.oci.data_volume_id
}

output "backup_bucket" {
  value = module.oci.backup_bucket_name
}
