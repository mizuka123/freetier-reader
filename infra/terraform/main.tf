locals {
  name             = "freetier-reader"
  compartment_ocid = coalesce(var.compartment_ocid, var.tenancy_ocid)
  vcn_cidr         = "10.0.0.0/16"
  data_mount       = "/srv/freetier-reader"

  # VM 上の .env（Terraform 管理。再同期手順は docs/terraform.md）
  env_file = templatefile("${path.module}/templates/env.tftpl", {
    compose_profiles     = join(",", var.compose_profiles)
    reader_hostname      = var.reader_hostname
    admin_username       = var.admin_username
    admin_password       = random_password.admin.result
    postgres_password    = random_password.postgres.result
    tunnel_token         = module.cloudflare.tunnel_token
    webhook_token        = random_password.webhook_token.result
    x_allowed_users      = join(",", var.x_allowed_users)
    x_stale_hours        = var.x_stale_hours
    x_webhook_rss_image  = var.x_webhook_rss_image
    ifttt_tz_offset      = var.ifttt_tz_offset
    backup_dir           = "${local.data_mount}/backups"
    backup_namespace     = module.oci.backup_namespace
    backup_bucket        = module.oci.backup_bucket_name
    compartment_ocid     = local.compartment_ocid
    region               = var.oci_region
    healthcheck_ping_url = var.healthcheck_ping_url
    backup_ping_url      = var.backup_ping_url
  })

  cloud_init = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    env_file_b64         = base64encode(local.env_file)
    repo_url             = var.repo_url
    repo_ref             = var.repo_ref
    vcn_cidr             = local.vcn_cidr
    data_mount           = local.data_mount
    data_volume_gb       = var.data_volume_gb
    auto_update          = var.auto_update
    healthcheck_ping_url = var.healthcheck_ping_url
  })
}

# ---- 秘密値（state に保存される。state はコミットしないこと） ----
resource "random_password" "admin" {
  length  = 24
  special = false
}

resource "random_password" "postgres" {
  length  = 32
  special = false
}

resource "random_password" "webhook_token" {
  length  = 48
  special = false
}

resource "random_bytes" "tunnel_secret" {
  length = 32
}

# ---- Cloudflare: Tunnel / DNS / Access / WAF ----
module "cloudflare" {
  source = "./modules/cloudflare"

  name                    = local.name
  account_id              = var.cloudflare_account_id
  zone_id                 = var.cloudflare_zone_id
  hostname                = var.reader_hostname
  tunnel_secret           = random_bytes.tunnel_secret.base64
  allowed_emails          = var.allowed_emails
  create_otp_login_method = var.create_otp_login_method
  existing_idp_ids        = var.existing_access_idp_ids
  session_duration        = var.access_session_duration
  api_allowed_countries   = var.api_allowed_countries
  api_rate_limit_per_10s  = var.api_rate_limit_per_10s
}

# ---- OCI: ネットワーク / A1 VM / データボリューム / Bastion / バックアップ / 予算 ----
module "oci" {
  source = "./modules/oci"

  name                      = local.name
  tenancy_ocid              = var.tenancy_ocid
  compartment_ocid          = local.compartment_ocid
  region                    = var.oci_region
  vcn_cidr                  = local.vcn_cidr
  availability_domain_index = var.availability_domain_index
  instance_ocpus            = var.instance_ocpus
  instance_memory_gb        = var.instance_memory_gb
  boot_volume_gb            = var.boot_volume_gb
  data_volume_gb            = var.data_volume_gb
  ssh_public_key            = var.ssh_public_key
  bastion_client_cidrs      = var.bastion_client_cidrs
  backup_retention_days     = var.backup_retention_days
  budget_amount             = var.budget_amount
  budget_alert_email        = var.budget_alert_email
  user_data                 = local.cloud_init
}
