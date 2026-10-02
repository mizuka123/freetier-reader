terraform {
  # 変数バリデーションで他の変数を参照するため 1.9 以上
  required_version = ">= 1.9, < 2.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # state はデフォルトでローカル（gitignore 済み）。
  # OCI Object Storage に置く場合は backend.tf.example を参照。
}

provider "oci" {
  # ~/.oci/config のプロファイルで認証（docs/terraform.md 参照）
  config_file_profile = var.oci_config_profile
  region              = var.oci_region
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
