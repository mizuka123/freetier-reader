terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
  }
}

locals {
  shape = "VM.Standard.A1.Flex"
  # VM とデータボリュームは同じ AD に置く。VM の属性ではなくデータソースから取ることで、
  # VM を作り直しても（-replace）データボリュームが作り直し対象にならないようにする
  availability_domain = data.oci_identity_availability_domains.this.availability_domains[var.availability_domain_index].name
  # Bastion 名は英数字のみ
  bastion_name = replace(var.name, "/[^A-Za-z0-9]/", "")
}

data "oci_identity_availability_domains" "this" {
  compartment_id = var.tenancy_ocid
}

data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = local.shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# ---- ネットワーク（インターネットからの受信は全閉、送信のみ許可） ----
resource "oci_core_vcn" "this" {
  compartment_id = var.compartment_ocid
  display_name   = var.name
  cidr_blocks    = [var.vcn_cidr]
  dns_label      = "ftreader"
}

resource "oci_core_internet_gateway" "this" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = var.name
  enabled        = true
}

resource "oci_core_route_table" "this" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = var.name

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.this.id
  }
}

resource "oci_core_security_list" "this" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = var.name

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  # SSH は VCN 内（OCI Bastion）からのみ。インターネットからは受け付けない
  ingress_security_rules {
    protocol = "6"
    source   = var.vcn_cidr
    tcp_options {
      min = 22
      max = 22
    }
  }
}

resource "oci_core_subnet" "this" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.this.id
  display_name               = var.name
  cidr_block                 = cidrsubnet(var.vcn_cidr, 8, 1)
  dns_label                  = "public"
  route_table_id             = oci_core_route_table.this.id
  security_list_ids          = [oci_core_security_list.this.id]
  prohibit_public_ip_on_vnic = false
}

# ---- A1 インスタンス ----
resource "oci_core_instance" "this" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  display_name        = var.name
  shape               = local.shape

  shape_config {
    ocpus         = var.instance_ocpus
    memory_in_gbs = var.instance_memory_gb
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.this.id
    assign_public_ip = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(var.user_data)
  }

  lifecycle {
    # metadata（.env を含む user_data・SSH 鍵）やイメージ更新で VM が作り直されるのを防ぐ。
    # 設定の反映は docs/terraform.md の「設定を変更する」を参照。データはデータボリュームにあり、作り直しても残る。
    ignore_changes = [metadata, source_details[0].source_id]
  }
}

# ---- データ用ブロックボリューム（Docker のデータ・ローカルバックアップ） ----
resource "oci_core_volume" "data" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  display_name        = "${var.name}-data"
  size_in_gbs         = var.data_volume_gb

  lifecycle {
    # 誤って terraform destroy / 作り直しでデータを消さないため。完全に削除する場合はこの行を外す
    prevent_destroy = true
  }
}

resource "oci_core_volume_attachment" "data" {
  attachment_type = "paravirtualized"
  instance_id     = oci_core_instance.this.id
  volume_id       = oci_core_volume.data.id
  display_name    = "${var.name}-data"
}

# ---- OCI Bastion（障害時の SSH 経路。無料） ----
resource "oci_bastion_bastion" "this" {
  bastion_type                 = "standard"
  compartment_id               = var.compartment_ocid
  target_subnet_id             = oci_core_subnet.this.id
  name                         = local.bastion_name
  client_cidr_block_allow_list = var.bastion_client_cidrs
  max_session_ttl_in_seconds   = 10800
}

# ---- バックアップ用 Object Storage ----
data "oci_objectstorage_namespace" "this" {
  compartment_id = var.compartment_ocid
}

resource "oci_objectstorage_bucket" "backup" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.this.namespace
  name           = "${var.name}-backup"
  access_type    = "NoPublicAccess"
}

resource "oci_objectstorage_object_lifecycle_policy" "backup" {
  namespace = data.oci_objectstorage_namespace.this.namespace
  bucket    = oci_objectstorage_bucket.backup.name

  rules {
    name        = "delete-after-${var.backup_retention_days}-days"
    action      = "DELETE"
    target      = "objects"
    is_enabled  = true
    time_amount = var.backup_retention_days
    time_unit   = "DAYS"
  }

  depends_on = [oci_identity_policy.this]
}

# VM（インスタンスプリンシパル）にバックアップバケットへの書き込みだけを許可
resource "oci_identity_dynamic_group" "this" {
  compartment_id = var.tenancy_ocid
  name           = "${var.name}-instance"
  description    = "freetier-reader VM"
  matching_rule  = "ALL {instance.id = '${oci_core_instance.this.id}'}"
}

resource "oci_identity_policy" "this" {
  compartment_id = var.compartment_ocid
  name           = "${var.name}-backup"
  description    = "freetier-reader backup and lifecycle"
  statements = [
    "Allow dynamic-group ${oci_identity_dynamic_group.this.name} to read buckets in compartment id ${var.compartment_ocid} where target.bucket.name = '${oci_objectstorage_bucket.backup.name}'",
    "Allow dynamic-group ${oci_identity_dynamic_group.this.name} to manage objects in compartment id ${var.compartment_ocid} where target.bucket.name = '${oci_objectstorage_bucket.backup.name}'",
    "Allow service objectstorage-${var.region} to manage object-family in compartment id ${var.compartment_ocid}",
  ]
}

# ---- 予算アラート（無料枠を超えて課金が発生したら通知） ----
resource "oci_budget_budget" "this" {
  compartment_id = var.tenancy_ocid
  display_name   = var.name
  amount         = var.budget_amount
  reset_period   = "MONTHLY"
  target_type    = "COMPARTMENT"
  targets        = [var.tenancy_ocid]
}

resource "oci_budget_alert_rule" "actual" {
  budget_id      = oci_budget_budget.this.id
  display_name   = "${var.name}-actual-spend"
  type           = "ACTUAL"
  threshold      = 1
  threshold_type = "PERCENTAGE"
  recipients     = var.budget_alert_email
  message        = "OCI で課金が発生しました。Always Free の範囲を超えていないか確認してください。"
}
