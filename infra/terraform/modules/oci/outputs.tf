output "instance_id" {
  value = oci_core_instance.this.id
}

output "instance_public_ip" {
  value = oci_core_instance.this.public_ip
}

output "backup_namespace" {
  value = data.oci_objectstorage_namespace.this.namespace
}

output "backup_bucket_name" {
  value = oci_objectstorage_bucket.backup.name
}
