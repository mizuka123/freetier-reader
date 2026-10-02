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

variable "ssh_public_key" {
  type = string
}

variable "ssh_allowed_cidr" {
  type = string
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
