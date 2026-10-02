locals {
  compartment_ocid = coalesce(var.compartment_ocid, var.tenancy_ocid)
  name             = "freetier-reader"
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

  name                   = local.name
  account_id             = var.cloudflare_account_id
  zone_id                = var.cloudflare_zone_id
  hostname               = var.reader_hostname
  tunnel_secret          = random_bytes.tunnel_secret.base64
  allowed_emails         = var.allowed_emails
  session_duration       = var.access_session_duration
  api_allowed_countries  = var.api_allowed_countries
  api_rate_limit_per_10s = var.api_rate_limit_per_10s
}

# ---- OCI: ネットワーク / A1 VM / バックアップ / 予算 ----
module "oci" {
  source = "./modules/oci"

  name                      = local.name
  tenancy_ocid              = var.tenancy_ocid
  compartment_ocid          = local.compartment_ocid
  region                    = var.oci_region
  availability_domain_index = var.availability_domain_index
  instance_ocpus            = var.instance_ocpus
  instance_memory_gb        = var.instance_memory_gb
  boot_volume_gb            = var.boot_volume_gb
  ssh_public_key            = var.ssh_public_key
  ssh_allowed_cidr          = var.ssh_allowed_cidr
  budget_amount             = var.budget_amount
  budget_alert_email        = var.budget_alert_email
  user_data                 = local.cloud_init
}

locals {
  env_file = templatefile("${path.module}/templates/env.tftpl", {
    compose_profiles  = join(",", var.compose_profiles)
    reader_hostname   = var.reader_hostname
    admin_username    = var.admin_username
    admin_password    = random_password.admin.result
    postgres_password = random_password.postgres.result
    tunnel_token      = module.cloudflare.tunnel_token
    webhook_token     = random_password.webhook_token.result
    x_allowed_users   = join(",", var.x_allowed_users)
    ifttt_tz_offset   = var.ifttt_tz_offset
    backup_namespace  = module.oci.backup_namespace
    backup_bucket     = module.oci.backup_bucket_name
  })

  cloud_init = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    env_file_b64 = base64encode(local.env_file)
    repo_url     = var.repo_url
    repo_ref     = var.repo_ref
  })
}
