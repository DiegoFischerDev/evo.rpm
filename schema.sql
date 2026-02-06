-- Tabela de leads para o backend evo (MySQL)

CREATE TABLE IF NOT EXISTS gestora_de_credito (
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
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_gestora_de_credito_whatsapp_number (whatsapp_number)
);

