const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = 3000;

// Se não tiver arquivos front-end, pode comentar esta linha
app.use(express.static('public'));
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

// Mapeamento de offsets por modelo
const mileageLocations = {
  titan160: [
    0x0098, 0x009C, 0x00A0, 0x00A4, 0x00A8, 0x00AC,
    0x00B0, 0x00B4, 0x00B8, 0x00BC, 0x00C0, 0x00C4,
    0x00C8, 0x00CC, 0x00D0, 0x00D4, 0x00D8, 0x00DA,
    0x00DE, 0x00E0, 0x00E2
  ],
  biz2018: [
    0x005C, 0x0060, 0x0064, 0x0068, 0x006C,
    0x0070, 0x0074, 0x0078, 0x007C, 0x0080,
    0x0084, 0x0088, 0x008C, 0x0098
  ],
  cb500x2023: [
    0x0100, 0x0104, 0x0108, 0x010C,
    0x0110, 0x0114, 0x0118, 0x011C,
    0x0120, 0x0124, 0x0128, 0x012C,
    0x0130, 0x0134, 0x0138, 0x013C
  ],
  crosser150: [
    0x00A0, 0x00A4, 0x00A8,
    0x00B0, 0x00B4, 0x00B8,
    0x00C0, 0x00C4, 0x00C8,
    0x00D0, 0x00D4, 0x00D8
  ]
};

function convertMileageToEepromBytes(km) {
  const factor = 0.031;
  const valor = Math.floor(km * factor);
  const complemento = 0xFFFF - valor;
  const buf = Buffer.alloc(4);
  buf.writeUInt16LE(valor, 0);
  buf.writeUInt16LE(complemento, 2);
  return buf;
}

function getModelConfig(modelo) {
  switch (modelo) {
    case 'titan160':
      return { template: 'titan160.bin', offsets: mileageLocations.titan160 };
    case 'biz2018':
      return { template: 'biz2018.bin', offsets: mileageLocations.biz2018 };
    case 'cb500x2023':
      return { template: 'cb500x2023.bin', offsets: mileageLocations.cb500x2023 };
    case 'crosser150':
      return { template: 'crosser150_base.bin', offsets: mileageLocations.crosser150 };
    default:
      throw new Error(`Modelo inválido: ${modelo}`);
  }
}

// Rota para alterar e baixar o template
app.post('/alterar-e-baixar-template', async (req, res) => {
  try {
    const { new_mileage, model } = req.body;
    if (!new_mileage || !model) {
      return res.status(400).send('Parâmetros "model" e "new_mileage" são obrigatórios');
    }
    const km = parseInt(new_mileage, 10);
    if (isNaN(km) || km < 0) {
      return res.status(400).send(`KM inválido: ${new_mileage}`);
    }

    let config;
    try {
      config = getModelConfig(model);
    } catch {
      return res.status(400).send(`Modelo não suportado: ${model}`);
    }

    const { template, offsets } = config;
    const filePath = path.join(__dirname, 'data', template);

    const original = await fs.readFile(filePath);
    const buffer = Buffer.from(original);
    const kmBytes = convertMileageToEepromBytes(km);

    for (const offset of offsets) {
      if (offset + 4 <= buffer.length) {
        kmBytes.copy(buffer, offset);
      } else {
        return res.status(500).send(`Offset inválido: 0x${offset.toString(16)}`);
      }
    }

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${model}_${km}km.bin"`
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(buffer);

  } catch (err) {
    console.error('Erro gerar arquivo:', err);
    res.status(500).send(`Erro interno: ${err.message}`);
  }
});

// Rota para ler KM de um binário
app.post('/ler-km', upload.single('arquivo_bin'), async (req, res) => {
  try {
    const bin = await fs.readFile(req.file.path);
    const len = bin.length;
    let modelo, leituraOffsets;

    // Auxiliar: verifica checksum v+c===0xFFFF
    const isValidChecksum = o =>
      o + 4 <= len &&
      (bin.readUInt16LE(o) + bin.readUInt16LE(o + 2)) === 0xFFFF;

    // 1) Biz 2018
    if (mileageLocations.biz2018.every(isValidChecksum)) {
      modelo = 'biz2018';
      leituraOffsets = mileageLocations.biz2018;

    // 2) Crosser 150
    } else if (mileageLocations.crosser150.every(isValidChecksum)) {
      modelo = 'crosser150';
      leituraOffsets = mileageLocations.crosser150;

    // 3) CB500X2023 (presença de valor > 0 nos primeiros offsets)
    } else if (
      [0x0100, 0x0104].every(o => o + 4 <= len && bin.readUInt16LE(o) > 0)
    ) {
      modelo = 'cb500x2023';
      leituraOffsets = mileageLocations.cb500x2023;

    // 4) Fallback SEM CONDIÇÃO: assume Titan160
    } else {
      modelo = 'titan160';
      leituraOffsets = mileageLocations.titan160;
    }

    // Extrai só os valores válidos
    const valores = leituraOffsets
      .filter(isValidChecksum)
      .map(o => bin.readUInt16LE(o));

    if (valores.length === 0) {
      return res.status(400).send('Não foi possível identificar o KM');
    }

    // Valor mais frequente e conversão inversa
    const freq = valores.reduce((acc, v) => {
      acc[v] = (acc[v] || 0) + 1;
      return acc;
    }, {});
    const [valorMaisFreq] = Object.entries(freq)
      .sort(([, a], [, b]) => b - a)[0];
    const km = Math.round(Number(valorMaisFreq) / 0.031);

    res.json({ modelo, km });

  } catch (err) {
    console.error('Erro ler arquivo:', err);
    res.status(500).send(`Erro processar arquivo: ${err.message}`);
  }
});

app.listen(port, () => {
  console.log(`Servidor em http://localhost:${port}`);
});
