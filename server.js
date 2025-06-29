// server.js

const express   = require('express');
const multer    = require('multer');
const fs        = require('fs').promises;
const path      = require('path');
const session   = require('express-session');
const bcrypt    = require('bcrypt');

const app  = express();
const port = process.env.PORT || 3000;

// — Sessão & Autenticação — 

const users = [
  {
    username: 'admin',
    passwordHash: bcrypt.hashSync('suaSenhaSecreta', 10)
  }
];

app.use(session({
  secret: 'umSegredoBemLongoAqui',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

function requireLogin(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (user && await bcrypt.compare(password, user.passwordHash)) {
    req.session.user = user.username;
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.use((req, res, next) => {
  const open = ['/login','/logout'];
  if (open.some(p => req.path.startsWith(p))) return next();
  requireLogin(req, res, next);
});

app.get('/', (req, res) => {
  res.send(`
    <h1>Bem-vindo, ${req.session.user}!</h1>
    <p><a href="/logout">Sair</a></p>
    <p>POST /ler-km (form-data: arquivo_bin + opcional model)</p>
    <p>POST /alterar-e-baixar-template (JSON: model, new_mileage)</p>
  `);
});

// — Offsets e funções de BIN —

const upload = multer({ dest: 'uploads/' });

const mileageLocations = {
  titan160: [ 0x0098, 0x009C, /* ... */ 0x00E2 ],
  biz2018:  [ 0x005C, 0x0060, /* ... */ 0x0098 ],
  cb500x2023: [ 0x0100, 0x0104, /* ... */ 0x013C ],
  crosser150: [ 0x00A0, 0x00A4, /* ... */ 0x00D8 ]
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

// — Rota de geração de BIN —

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

    const { template, offsets } = getModelConfig(model);
    const original = await fs.readFile(path.join(__dirname, 'data', template));
    const buffer   = Buffer.from(original);
    const kmBytes  = convertMileageToEepromBytes(km);

    for (const o of offsets) {
      if (o + 4 <= buffer.length) {
        kmBytes.copy(buffer, o);
      } else {
        return res.status(500).send(`Offset inválido: 0x${o.toString(16)}`);
      }
    }

    res.setHeader('Content-Disposition',
      `attachment; filename="${model}_${km}km.bin"`
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(buffer);

  } catch (err) {
    console.error(err);
    res.status(500).send(`Erro interno: ${err.message}`);
  }
});

// — Rota de leitura de KM —

app.post('/ler-km', upload.single('arquivo_bin'), async (req, res) => {
  try {
    const bin = await fs.readFile(req.file.path);
    const len = bin.length;

    // 1) Override via form-data
    let modelo = req.body.model;
    let leituraOffsets = mileageLocations[modelo] || null;

    // 2) Se não veio override, detecta automaticamente
    if (!leituraOffsets) {
      // Biz
      const isChecksum = o =>
        o + 4 <= len &&
        bin.readUInt16LE(o) + bin.readUInt16LE(o + 2) === 0xFFFF;

      if (mileageLocations.biz2018.every(isChecksum)) {
        modelo = 'biz2018';
        leituraOffsets = mileageLocations.biz2018;
      } else if (mileageLocations.crosser150.every(isChecksum)) {
        modelo = 'crosser150';
        leituraOffsets = mileageLocations.crosser150;
      } else if (
        [0x0100, 0x0104].every(o => o + 4 <= len && bin.readUInt16LE(o) > 0)
      ) {
        modelo = 'cb500x2023';
        leituraOffsets = mileageLocations.cb500x2023;
      } else {
        modelo = 'titan160';
        leituraOffsets = mileageLocations.titan160;
      }
    }

    // 3) Lê TODOS os valores v (ignorando checksum)
    const valores = leituraOffsets
      .map(o => (o + 2 <= len ? bin.readUInt16LE(o) : null))
      .filter(v => v !== null);

    if (!valores.length) {
      return res.status(400).send('Não foi possível identificar o KM');
    }

    // 4) Frequência e conversão inversa
    const freq = valores.reduce((acc, v) => {
      acc[v] = (acc[v] || 0) + 1;
      return acc;
    }, {});
    const [vMaisFreq] = Object.entries(freq)
      .sort(([, a], [, b]) => b - a)[0];
    const km = Math.round(Number(vMaisFreq) / 0.031);

    res.json({ modelo, km });

  } catch (err) {
    console.error(err);
    res.status(500).send(`Erro processar arquivo: ${err.message}`);
  }
});

app.listen(port, () => {
  console.log(`Servidor em http://localhost:${port}`);
});
