variable "name" {
  type = string
}

variable "tenancy_ocid" {
  type = string
}

variable "compartment_ocid" {
  type = string
}

variable "region" {
  type = string
}

variable "vcn_cidr" {
  type = string
}

variable "availability_domain_index" {
  type = number
}

variable "instance_ocpus" {
  type = number
}

variable "instance_memory_gb" {
  type = number
}

variable "boot_volume_gb" {
  type = number
}

variable "data_volume_gb" {
  type = number
}

variable "ssh_public_key" {
  type = string
}

variable "bastion_client_cidrs" {
  type = list(string)
}

variable "backup_retention_days" {
  type = number
}

variable "budget_amount" {
  type = number
}

variable "budget_alert_email" {
  type = string
}

variable "user_data" {
  description = "cloud-init（.env を含むため sensitive）"
  type        = string
  sensitive   = true
}
