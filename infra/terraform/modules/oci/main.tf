terraform {
  required_providers {
    oci = {
      source = "oracle/oci"
    }
  }
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

locals {
  shape = "VM.Standard.A1.Flex"
}

# ---- ネットワーク（受信は全閉、送信のみ許可） ----
resource "oci_core_vcn" "this" {
  compartment_id = var.compartment_ocid
  display_name   = var.name
  cidr_blocks    = ["10.0.0.0/16"]
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

  dynamic "ingress_security_rules" {
    for_each = var.ssh_allowed_cidr == null ? [] : [var.ssh_allowed_cidr]
    content {
      protocol = "6"
      source   = ingress_security_rules.value
      tcp_options {
        min = 22
        max = 22
      }
    }
  }
}

resource "oci_core_subnet" "this" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.this.id
  display_name               = var.name
  cidr_block                 = "10.0.1.0/24"
  dns_label                  = "public"
  route_table_id             = oci_core_route_table.this.id
  security_list_ids          = [oci_core_security_list.this.id]
  prohibit_public_ip_on_vnic = false
}

# ---- A1 インスタンス ----
resource "oci_core_instance" "this" {
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.this.availability_domains[var.availability_domain_index].name
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

  metadata = merge(
    { user_data = base64encode(var.user_data) },
    var.ssh_public_key == "" ? {} : { ssh_authorized_keys = var.ssh_public_key },
  )

  lifecycle {
    # user_data（.env を含む）やイメージ更新で VM が作り直されデータが消えるのを防ぐ。
    # 設定を変えたい場合は VM 上の /opt/freetier-reader/.env を直接編集する（docs/terraform.md）。
    ignore_changes = [metadata, source_details[0].source_id]
  }
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
    name        = "delete-after-7-days"
    action      = "DELETE"
    target      = "objects"
    is_enabled  = true
    time_amount = 7
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
