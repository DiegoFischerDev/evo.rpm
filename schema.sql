-- Crédito Habitação (CH): tabelas para o backend evo (MySQL)
-- Alinhado com ia-app/migrations/005_recreate_ch_tables.sql

CREATE TABLE IF NOT EXISTS ch_gestoras (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  whatsapp VARCHAR(32) NOT NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ch_gestoras_ativo (ativo)
);

CREATE TABLE IF NOT EXISTS ch_leads (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  whatsapp_number VARCHAR(32) NOT NULL,
  nome VARCHAR(255),
  email VARCHAR(255),
  origem_instancia VARCHAR(64),
  estado VARCHAR(32) NOT NULL,
  estado_anterior VARCHAR(32),
  docs_enviados TINYINT(1) NOT NULL DEFAULT 0,
  docs_enviados_em DATETIME NULL,
  estado_civil VARCHAR(128) NULL,
  num_dependentes VARCHAR(16) NULL,
  email_verification_code VARCHAR(10) NULL,
  email_verification_sent_at DATETIME NULL,
  pending_nome VARCHAR(255) NULL,
  pending_email VARCHAR(255) NULL,
  gestora_id INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ch_leads_whatsapp_number (whatsapp_number),
  KEY idx_ch_leads_gestora_id (gestora_id)
);
