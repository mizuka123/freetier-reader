output "instance_id" {
  value = oci_core_instance.this.id
}

output "instance_private_ip" {
  value = oci_core_instance.this.private_ip
}

output "bastion_id" {
  value = oci_bastion_bastion.this.id
}

output "data_volume_id" {
  value = oci_core_volume.data.id
}

output "backup_namespace" {
  value = data.oci_objectstorage_namespace.this.namespace
}

output "backup_bucket_name" {
  value = oci_objectstorage_bucket.backup.name
}
