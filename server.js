const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.MONEYRAIN_SECRET;
const MEIN_PPC_API_KEY = process.env.MEIN_PPC_API_KEY || '4a3eb2346df3919fa987bfda30c39e3f';
const FAUCETPAY_API_KEY = process.env.FAUCETPAY_API_KEY;
const FAUCETPAY_CURRENCY = (process.env.FAUCETPAY_CURRENCY || 'USDT').trim().toUpperCase();

const MINIMO_SAQUE = parseFloat(process.env.MINIMO_SAQUE || '0.01');
const MAX_SAQUE = parseFloat(process.env.MAX_SAQUE || '0.08');
const TETO_GLOBAL_24H = parseFloat(process.env.TETO_GLOBAL_24H || '0.08');
const INTERVALO_MINUTOS_USUARIO = parseInt(process.env.INTERVALO_MINUTOS_USUARIO || '15', 10);

// Parâmetros de auditoria de comportamento humano (ajustáveis via .env)
const MIN_TAREFAS_AUDITORIA = parseInt(process.env.MIN_TAREFAS_AUDITORIA || '2', 10);
const TEMPO_MINIMO_POR_TAREFA_SEG = parseFloat(process.env.TEMPO_MINIMO_POR_TAREFA_SEG || '12');

// Função blindada para normalizar e-mails (remove pontos do gmail, lowercase, e conserta falta de @)
function normalizarEmail(email) {
    if (!email) return '';
    let limpo = email.trim().toLowerCase();

    if (!limpo.includes('@') && limpo.endsWith('gmail.com')) {
        let nome = limpo.replace('gmail.com', '').replace(/[^a-z0-9]/g, '');
        limpo = `${nome}@gmail.com`;
    }

    if (limpo.endsWith('@gmail.com') || limpo.endsWith('@googlemail.com')) {
        let partes = limpo.split('@');
        let usuario = partes[0].replace(/\./g, '');
        return `${usuario}@gmail.com`;
    }

    return limpo;
}

// Extrai o IP real do visitante considerando proxies / Render
function obterIpCliente(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
        const primeiroIp = String(xff).split(',')[0].trim();
        if (primeiroIp) return primeiroIp;
    }
    const rawIp = req.ip || req.socket?.remoteAddress || '';
    return rawIp.replace(/^::ffff:/, '');
}

// Valida o token diretamente no Mein-PPC pelo servidor
async function verificarTokenMeinPPC(token) {
    if (!token || typeof token !== 'string' || token.trim().length < 5) {
        return { valid: false, message: 'Token de verificação ausente ou inválido.' };
    }

    const params = new URLSearchParams({
        api: MEIN_PPC_API_KEY,
        token: token.trim()
    });

    const response = await fetch(`https://mein-ppc.com/api/captcha-verify.php?${params.toString()}`, {
        method: 'GET'
    });

    if (!response.ok) {
        return { valid: false, message: 'Falha ao consultar o serviço de verificação.' };
    }

    const data = await response.json();
    console.log('Resposta captcha-verify.php:', data);

    if (data && (data.valid === true || data.válido === true)) {
        return { valid: true, raw: data };
    }

    return {
        valid: false,
        message: data?.error || data?.message || 'Verificação do captcha não validada ou expirada.'
    };
}

// Audita as tarefas do usuário e avalia se a média de intervalo entre cliques/conclusões é humana
async function auditarAtividadeHumana(client, projeto, email) {
    const resTarefas = await client.query(
        `SELECT id, nome_tarefa, pontos, data_registro
         FROM historico_ganhos
         WHERE projeto = $1 AND email = $2 AND origem = 'moneyrain'
         ORDER BY data_registro ASC, id ASC`,
        [projeto, email]
    );

    const tarefas = resTarefas.rows;
    const totalTarefas = tarefas.length;

    if (totalTarefas < MIN_TAREFAS_AUDITORIA) {
        return {
            aprovado: false,
            motivo: `Histórico insuficiente para liberação automática (${totalTarefas}/${MIN_TAREFAS_AUDITORIA} tarefas).`
        };
    }

    if (totalTarefas >= 2) {
        let somaIntervalosSeg = 0;
        let paresContados = 0;

        for (let i = 1; i < tarefas.length; i++) {
            const anterior = new Date(tarefas[i - 1].data_registro).getTime();
            const atual = new Date(tarefas[i].data_registro).getTime();
            if (Number.isFinite(anterior) && Number.isFinite(atual) && atual >= anterior) {
                somaIntervalosSeg += (atual - anterior) / 1000;
                paresContados++;
            }
        }

        if (paresContados > 0) {
            const mediaSegundos = somaIntervalosSeg / paresContados;
            if (mediaSegundos < TEMPO_MINIMO_POR_TAREFA_SEG) {
                return {
                    aprovado: false,
                    motivo: `Ritmo de conclusão abaixo do esperado (${mediaSegundos.toFixed(1)}s por tarefa).`
                };
            }
        }
    }

    return {
        aprovado: true,
        motivo: 'Auditoria de atividades e ritmo humano aprovada.'
    };
}

// Envia pagamento instantâneo via FaucetPay Merchant API (valor convertido para satoshis 10^8)
async function enviarPagamentoFaucetPay(destino, valorMoeda, moeda = FAUCETPAY_CURRENCY) {
    if (!FAUCETPAY_API_KEY) {
        return {
            ok: false,
            motivo: 'FAUCETPAY_API_KEY não configurada no ambiente.'
        };
    }

    const satoshis = Math.round(Number(valorMoeda) * 1e8);
    if (!Number.isFinite(satoshis) || satoshis < 1) {
        return {
            ok: false,
            motivo: 'Valor inválido para conversão em satoshis.'
        };
    }

    const params = new URLSearchParams();
    params.append('api_key', FAUCETPAY_API_KEY);
    params.append('amount', String(satoshis));
    params.append('to', destino);
    params.append('currency', moeda);

    const fpResp = await fetch('https://faucetpay.io/api/v1/send', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
    });

    const rawText = await fpResp.text();
    let fpData;
    try {
        fpData = JSON.parse(rawText);
    } catch {
        fpData = { raw: rawText };
    }

    if (fpResp.ok && fpData && fpData.status === 200) {
        return {
            ok: true,
            comprovante: fpData.payout_id ? String(fpData.payout_id) : 'FAUCETPAY_OK',
            raw: fpData
        };
    }

    return {
        ok: false,
        motivo: fpData?.message || fpData?.error || `Falha API FaucetPay (HTTP ${fpResp.status})`,
        raw: fpData
    };
}

// Middlewares
app.use('/api/moneyrain-callback', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Conexão com o PostgreSQL do Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Auto-criação de tabelas e índices
async function inicializarBanco() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                projeto VARCHAR(50) NOT NULL,
                email VARCHAR(255) NOT NULL,
                indicado_por VARCHAR(255),
                criado_em TIMESTAMP DEFAULT NOW(),
                CONSTRAINT unique_projeto_email UNIQUE (projeto, email)
            );

            CREATE TABLE IF NOT EXISTS historico_ganhos (
                id SERIAL PRIMARY KEY,
                projeto VARCHAR(50) NOT NULL,
                email VARCHAR(255) NOT NULL,
                origem VARCHAR(50) NOT NULL,
                pontos NUMERIC(18, 8) NOT NULL,
                nome_tarefa VARCHAR(100),
                referencia_id VARCHAR(255),
                data_registro TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS saques (
                id SERIAL PRIMARY KEY,
                projeto VARCHAR(50) NOT NULL,
                email VARCHAR(255) NOT NULL,
                pontos_solicitados NUMERIC(18, 8) NOT NULL,
                valor_solicitado NUMERIC(18, 8) DEFAULT 0,
                chave_pix VARCHAR(255) NOT NULL,
                status VARCHAR(20) DEFAULT 'Waiting',
                data_solicitacao TIMESTAMP DEFAULT NOW(),
                data_aprovacao TIMESTAMP,
                comprovante VARCHAR(100)
            );

            CREATE TABLE IF NOT EXISTS tokens_usados (
                token VARCHAR(255) PRIMARY KEY,
                projeto VARCHAR(50) NOT NULL DEFAULT 'cashrain',
                email VARCHAR(255) NOT NULL DEFAULT '',
                criado_em TIMESTAMP DEFAULT NOW()
            );

            ALTER TABLE tokens_usados
                ADD COLUMN IF NOT EXISTS projeto VARCHAR(50) NOT NULL DEFAULT 'cashrain',
                ADD COLUMN IF NOT EXISTS email VARCHAR(255) NOT NULL DEFAULT '',
                ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP DEFAULT NOW();

            CREATE TABLE IF NOT EXISTS metricas_divulgacao (
                id SERIAL PRIMARY KEY,
                projeto VARCHAR(50) NOT NULL,
                email_afiliado VARCHAR(255) NOT NULL,
                utm_source VARCHAR(100) DEFAULT 'direto',
                utm_medium VARCHAR(100) DEFAULT 'indefinido',
                utm_campaign VARCHAR(100) DEFAULT 'geral',
                acao VARCHAR(50) NOT NULL,
                data_registro TIMESTAMP DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_saques_status ON saques(status);
            CREATE INDEX IF NOT EXISTS idx_ganhos_email ON historico_ganhos(email);
            CREATE INDEX IF NOT EXISTS idx_ganhos_ref ON historico_ganhos(referencia_id);
        `);

        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'tokens_usados'
                      AND column_name = 'finalidade'
                ) THEN
                    ALTER TABLE tokens_usados ALTER COLUMN finalidade SET DEFAULT 'confirmar_saque';
                    UPDATE tokens_usados SET finalidade = 'confirmar_saque' WHERE finalidade IS NULL;
                END IF;
            END $$;
        `);

        console.log('✅ Banco de dados sincronizado com sucesso!');
    } catch (err) {
        console.error('❌ Erro ao inicializar banco de dados:', err);
    }
}

// ==========================================
// ROTAS DE FRONTEND
// ==========================================
app.get('/', (req, res) => res.redirect('/cashrain'));
app.get('/cashrain', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cashrain.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ==========================================
// REGISTRO / LOGIN COM ATUALIZAÇÃO DA ÁRVORE
// ==========================================
app.post('/api/login', async (req, res) => {
    const projeto = req.body.projeto;
    const email = normalizarEmail(req.body.email);
    let indicado_por = normalizarEmail(req.body.indicado_por);

    if (!projeto || !email) {
        return res.status(400).json({ success: false, message: 'Dados incompletos.' });
    }

    if (indicado_por === email) indicado_por = null;

    if (!indicado_por && email !== 'chensonbh763@gmail.com') {
        indicado_por = 'chensonbh763@gmail.com';
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `INSERT INTO usuarios (projeto, email, indicado_por)
             VALUES ($1, $2, $3)
             ON CONFLICT (projeto, email)
             DO UPDATE SET indicado_por = EXCLUDED.indicado_por`,
            [projeto, email, indicado_por]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: 'Login e árvore atualizados com sucesso!' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Erro no login:', err);
        res.status(500).json({ success: false, message: 'Erro interno no login.' });
    } finally {
        client.release();
    }
});

// ==========================================
// CONSULTA DE SALDO
// ==========================================
app.get('/api/saldo', async (req, res) => {
    const projeto = req.query.projeto;
    const email = normalizarEmail(req.query.email);

    if (!projeto || !email) {
        return res.status(400).json({ error: 'Projeto e e-mail são obrigatórios.' });
    }

    try {
        const resGanhos = await pool.query(
            'SELECT COALESCE(SUM(pontos), 0) as total FROM historico_ganhos WHERE projeto = $1 AND email = $2',
            [projeto, email]
        );
        const resSaques = await pool.query(
            "SELECT COALESCE(SUM(pontos_solicitados), 0) as total FROM saques WHERE projeto = $1 AND email = $2 AND status != 'rejected'",
            [projeto, email]
        );

        const totalGanho = parseFloat(resGanhos.rows[0].total);
        const totalSacado = parseFloat(resSaques.rows[0].total);
        const saldoDisponivel = Math.max(0, totalGanho - totalSacado).toFixed(8);

        res.json({
            saldo: saldoDisponivel,
            total_ganho: totalGanho.toFixed(8),
            total_sacado: totalSacado.toFixed(8)
        });
    } catch (err) {
        console.error('Erro ao consultar saldo:', err);
        res.status(500).json({ error: 'Erro interno ao consultar saldo.' });
    }
});

// ==========================================
// CRIAR DESAFIO CAPCHA NO SERVIDOR
// ==========================================
app.get('/api/criar-captcha', async (req, res) => {
    const ipVisitante = obterIpCliente(req);
    const strict = req.query.strict || '2';
    const urlDestino = req.query.url || 'callback';

    try {
        const params = new URLSearchParams({
            api: MEIN_PPC_API_KEY,
            url: String(urlDestino),
            strict: String(strict)
        });
        if (ipVisitante) {
            params.append('uip', ipVisitante);
        }

        const resposta = await fetch(`https://mein-ppc.com/api/captcha.php?${params.toString()}`);
        const dados = await resposta.json();

        if (!dados || (dados.status !== 'success' && dados.status !== 'sucesso') || !dados.code) {
            return res.status(502).json({
                success: false,
                message: 'Não foi possível gerar o desafio de verificação.'
            });
        }

        res.json({
            success: true,
            code: dados.code,
            url: dados.url || `https://mein-ppc.com/c/${dados.code}`,
            expires_at: dados.expires_at || dados.expira_em
        });
    } catch (err) {
        console.error('Erro ao criar captcha Mein-PPC:', err);
        res.status(500).json({ success: false, message: 'Erro interno ao criar desafio.' });
    }
});

// ==========================================
// CONFIRMAR SAQUE: CAPCHA -> AUDITORIA -> PAGAMENTO AUTOMÁTICO OU FILA
// ==========================================
app.post('/api/confirmar-saque', async (req, res) => {
    const projeto = (req.body.projeto || 'cashrain').trim().toLowerCase();
    const email = normalizarEmail(req.body.email);
    const destino = normalizarEmail(req.body.chave_pix_faucetpay || email);
    const tokenCaptcha = String(req.body.captcha_token || req.body.solve_token || '').trim();

    if (!projeto || !destino) {
        return res.status(400).json({ success: false, message: 'Dados incompletos.' });
    }

    if (!tokenCaptcha) {
        return res.status(400).json({ success: false, message: 'Token de verificação obrigatório.' });
    }

    // 1. Valida captcha Mein-PPC no servidor
    let verificacao;
    try {
        verificacao = await verificarTokenMeinPPC(tokenCaptcha);
    } catch (err) {
        console.error('Erro ao verificar token Mein-PPC:', err);
        return res.status(502).json({ success: false, message: 'Falha ao validar a verificação.' });
    }

    if (!verificacao.valid) {
        return res.status(400).json({
            success: false,
            message: verificacao.message || 'Verificação inválida ou expirada.'
        });
    }

    const client = await pool.connect();
    let saqueId = null;
    let saldoDisponivel = 0;
    let liberarAutomatico = false;
    let motivoFilaManual = '';

    try {
        await client.query('BEGIN');

        // Trava de concorrência por projeto + destinatário
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`saque_${projeto}_${destino}`]);

        // Impede reuso do mesmo token de captcha
        const colFinalidade = await client.query(`
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'tokens_usados'
              AND column_name = 'finalidade'
        `);

        const tokenInsert = colFinalidade.rowCount > 0
            ? await client.query(
                `INSERT INTO tokens_usados (token, projeto, email, finalidade)
                 VALUES ($1, $2, $3, 'confirmar_saque')
                 ON CONFLICT (token) DO NOTHING
                 RETURNING token`,
                [tokenCaptcha, projeto, destino]
            )
            : await client.query(
                `INSERT INTO tokens_usados (token, projeto, email)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (token) DO NOTHING
                 RETURNING token`,
                [tokenCaptcha, projeto, destino]
            );

        if (tokenInsert.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Este token de verificação já foi utilizado.'
            });
        }

        // Verifica intervalo mínimo entre solicitações do mesmo usuário
        const resUltimoSaque = await client.query(
            `SELECT data_solicitacao FROM saques
             WHERE projeto = $1 AND email = $2 AND status IN ('Paid', 'Processing', 'Waiting')
             ORDER BY data_solicitacao DESC LIMIT 1`,
            [projeto, destino]
        );

        if (resUltimoSaque.rows.length > 0) {
            const ultimo = new Date(resUltimoSaque.rows[0].data_solicitacao);
            const diffMinutos = (Date.now() - ultimo.getTime()) / 60000;
            if (diffMinutos < INTERVALO_MINUTOS_USUARIO) {
                await client.query('ROLLBACK');
                const faltam = Math.ceil(INTERVALO_MINUTOS_USUARIO - diffMinutos);
                return res.status(429).json({
                    success: false,
                    message: `Aguarde ${faltam} minuto(s) para solicitar um novo saque.`
                });
            }
        }

        // Calcula saldo real disponível
        const resGanhos = await client.query(
            'SELECT COALESCE(SUM(pontos), 0) as total FROM historico_ganhos WHERE projeto = $1 AND email = $2',
            [projeto, destino]
        );
        const resSaques = await client.query(
            "SELECT COALESCE(SUM(pontos_solicitados), 0) as total FROM saques WHERE projeto = $1 AND email = $2 AND status != 'rejected'",
            [projeto, destino]
        );

        const totalGanho = parseFloat(resGanhos.rows[0].total);
        const totalSacado = parseFloat(resSaques.rows[0].total);
        saldoDisponivel = Number((totalGanho - totalSacado).toFixed(8));

        if (saldoDisponivel < MINIMO_SAQUE) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: `Saldo insuficiente. Mínimo para saque é ${MINIMO_SAQUE.toFixed(8)}.`
            });
        }

        // 2. Auditoria de atividades e ritmo humano
        const auditoria = await auditarAtividadeHumana(client, projeto, destino);

        // Verifica teto máximo por saque e teto global em 24h (1440 min)
        const resTotal24h = await client.query(
            `SELECT COALESCE(SUM(valor_solicitado), 0) as total_24h FROM saques
             WHERE projeto = $1 AND status IN ('Paid', 'Processing')
             AND data_solicitacao >= NOW() - INTERVAL '1440 minutes'`,
            [projeto]
        );
        const totalPago24h = parseFloat(resTotal24h.rows[0].total_24h);

        if (!auditoria.aprovado) {
            liberarAutomatico = false;
            motivoFilaManual = auditoria.motivo;
        } else if (saldoDisponivel > MAX_SAQUE) {
            liberarAutomatico = false;
            motivoFilaManual = `Acima do teto automático por saque (${MAX_SAQUE}).`;
        } else if ((totalPago24h + saldoDisponivel) > TETO_GLOBAL_24H) {
            liberarAutomatico = false;
            motivoFilaManual = `Teto global de ${TETO_GLOBAL_24H} em 24h atingido.`;
        } else {
            liberarAutomatico = true;
        }

        const statusInicial = liberarAutomatico ? 'Processing' : 'Waiting';
        const obsInicial = liberarAutomatico ? null : motivoFilaManual.slice(0, 100);

        const insertRes = await client.query(
            `INSERT INTO saques (projeto, email, pontos_solicitados, valor_solicitado, chave_pix, status, data_solicitacao, comprovante)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
             RETURNING id`,
            [projeto, destino, saldoDisponivel, saldoDisponivel, destino, statusInicial, obsInicial]
        );
        saqueId = insertRes.rows[0].id;

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Erro na transação de confirmação de saque:', err);
        return res.status(500).json({ success: false, message: 'Erro interno ao processar solicitação.' });
    } finally {
        client.release();
    }

    // Se não passou na auditoria ou nos tetos automáticos, permanece em 'Waiting' para revisão manual
    if (!liberarAutomatico) {
        return res.json({
            success: true,
            status: 'Waiting',
            message: 'Saque registrado e enviado para validação/pagamento (Waiting).'
        });
    }

    // 3. Dispara pagamento automático via FaucetPay fora do lock transacional
    try {
        const envio = await enviarPagamentoFaucetPay(destino, saldoDisponivel, FAUCETPAY_CURRENCY);

        if (envio.ok) {
            await pool.query(
                "UPDATE saques SET status = 'Paid', data_aprovacao = NOW(), comprovante = $1 WHERE id = $2",
                [envio.comprovante.slice(0, 100), saqueId]
            );
            return res.json({
                success: true,
                status: 'Paid',
                comprovante: envio.comprovante,
                message: 'Saque aprovado e pago instantaneamente!'
            });
        }

        await pool.query(
            "UPDATE saques SET status = 'Waiting', comprovante = $1 WHERE id = $2",
            [`AUTO_FALLBACK: ${envio.motivo}`.slice(0, 100), saqueId]
        );
        return res.json({
            success: true,
            status: 'Waiting',
            message: 'Saque auditado e colocado em fila de processamento (Waiting).'
        });
    } catch (err) {
        console.error('Erro ao enviar pagamento automático FaucetPay:', err);
        await pool.query(
            "UPDATE saques SET status = 'Waiting', comprovante = $1 WHERE id = $2",
            ['AUTO_FALLBACK: Erro de rede na API'.slice(0, 100), saqueId]
        ).catch(() => {});

        return res.json({
            success: true,
            status: 'Waiting',
            message: 'Saque registrado e colocado em fila de processamento (Waiting).'
        });
    }
});

// ==========================================
// SOLICITAÇÃO DE SAQUE (MANTIDA PARA COMPATIBILIDADE)
// ==========================================
app.post('/api/solicitar-saque', async (req, res) => {
    const projeto = req.body.projeto;
    const email = normalizarEmail(req.body.email);
    const destino = normalizarEmail(req.body.chave_pix_faucetpay || email);

    if (!projeto || !destino) {
        return res.status(400).json({ success: false, message: 'Dados incompletos.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const resGanhos = await client.query(
            'SELECT COALESCE(SUM(pontos), 0) as total FROM historico_ganhos WHERE projeto = $1 AND email = $2',
            [projeto, destino]
        );
        const resSaques = await client.query(
            "SELECT COALESCE(SUM(pontos_solicitados), 0) as total FROM saques WHERE projeto = $1 AND email = $2 AND status != 'rejected'",
            [projeto, destino]
        );

        const totalGanho = parseFloat(resGanhos.rows[0].total);
        const totalSacado = parseFloat(resSaques.rows[0].total);
        const saldoDisponivel = totalGanho - totalSacado;

        if (saldoDisponivel < MINIMO_SAQUE) {
            await client.query('ROLLBACK');
            return res.json({ success: false, message: `Saldo insuficiente. Mínimo para saque é ${MINIMO_SAQUE}.` });
        }

        await client.query(
            `INSERT INTO saques (projeto, email, pontos_solicitados, valor_solicitado, chave_pix, status, data_solicitacao)
             VALUES ($1, $2, $3, $4, $5, 'Waiting', NOW())`,
            [projeto, destino, saldoDisponivel, saldoDisponivel, destino]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: 'Saque solicitado com sucesso!' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Erro ao solicitar saque:', err);
        res.status(500).json({ success: false, message: 'Erro interno ao processar solicitação.' });
    } finally {
        client.release();
    }
});

// ==========================================
// CALLBACK MONEYRAIN (REGISTRA GANHO PRINCIPAL)
// ==========================================
app.post('/api/moneyrain-callback', async (req, res) => {
    const signature = req.headers['x-moneyrain-signature'];
    const percentualUsuario = 0.70;

    let bodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

    const hmac = crypto.createHmac('sha256', SECRET);
    hmac.update(bodyBuffer);
    const hash = hmac.digest('hex');
    const expectedSignature = 'sha256=' + hash;

    if (signature && signature !== expectedSignature) {
        console.error("❌ Assinatura inválida no MoneyRain");
        return res.status(403).send('Bad signature');
    }

    let data;
    try {
        data = JSON.parse(bodyBuffer.toString('utf8'));
    } catch (e) {
        return res.status(400).send('Invalid JSON');
    }

    if (data.event === 'reward.completed') {
        const emailUser = normalizarEmail(data.external_uid);
        const rewardAmount = parseFloat(data.reward_currency_amount || 0);
        const viewId = data.view_id;
        const adType = data.ad_type ? data.ad_type.toUpperCase() : "Ad";
        const nomeTarefa = `MoneyRain ${adType}`;

        if (!emailUser || !viewId) return res.status(400).send('Missing user or view ID');
        if (rewardAmount <= 0) return res.status(200).send('Reward zero ignored');

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const check = await client.query(
                "SELECT 1 FROM historico_ganhos WHERE referencia_id = $1 AND origem = 'moneyrain'",
                [viewId.toString()]
            );

            if (check.rowCount > 0) {
                await client.query('ROLLBACK');
                return res.status(200).send('Already credited');
            }

            const ganhoLiquidoUsuario = (rewardAmount * percentualUsuario).toFixed(8);
            await client.query(
                `INSERT INTO historico_ganhos (projeto, email, origem, pontos, nome_tarefa, referencia_id, data_registro)
                 VALUES ('cashrain', $1, 'moneyrain', CAST($2 AS NUMERIC), $3, $4, NOW())`,
                [emailUser, ganhoLiquidoUsuario, nomeTarefa, viewId.toString()]
            );

            await client.query('COMMIT');
            console.log(`✅ MoneyRain Tarefa Registrada para ${emailUser} (ViewID: ${viewId})`);
            return res.status(200).send('OK');
        } catch (dbErr) {
            await client.query('ROLLBACK');
            console.error("🔥 Erro no Banco (MoneyRain):", dbErr);
            return res.status(500).send('Database error');
        } finally {
            client.release();
        }
    }

    res.status(400).send('Invalid event');
});

// ==========================================
// ROTINA DE PROCESSAMENTO E DISTRIBUIÇÃO DE COMISSÕES (N1, N2, N3)
// ==========================================
app.get('/api/processar-comissoes', async (req, res) => {
    const comissaoN1 = 0.05;
    const comissaoN2 = 0.03;
    const comissaoN3 = 0.02;
    const percentualOriginal = 0.70;

    const client = await pool.connect();
    try {
        const pendentes = await client.query(`
            SELECT h.email, h.pontos, h.referencia_id
            FROM historico_ganhos h
            WHERE h.projeto = 'cashrain'
              AND h.origem = 'moneyrain'
              AND NOT EXISTS (
                  SELECT 1 FROM historico_ganhos com
                  WHERE com.referencia_id = h.referencia_id || '_n1'
              )
            LIMIT 100
        `);

        let processados = 0;

        for (let row of pendentes.rows) {
            const emailUser = normalizarEmail(row.email);
            const viewId = row.referencia_id;
            const pontosLiquidos = parseFloat(row.pontos);
            const rewardAmount = pontosLiquidos / percentualOriginal;

            const userN1 = await client.query("SELECT indicado_por FROM usuarios WHERE LOWER(email) = LOWER($1) AND projeto = 'cashrain'", [emailUser]);
            let emailN1 = userN1.rows.length > 0 ? normalizarEmail(userN1.rows[0].indicado_por) : null;

            if (emailN1 && emailN1 !== emailUser) {
                const comissao1 = (rewardAmount * comissaoN1).toFixed(8);
                await client.query(
                    `INSERT INTO historico_ganhos (projeto, email, origem, pontos, nome_tarefa, referencia_id, data_registro)
                     VALUES ('cashrain', $1, 'indicacao_n1', CAST($2 AS NUMERIC), 'Comissão Nível 1', $3, NOW())
                     ON CONFLICT DO NOTHING`,
                    [emailN1, comissao1, viewId + '_n1']
                );

                const userN2 = await client.query("SELECT indicado_por FROM usuarios WHERE LOWER(email) = LOWER($1) AND projeto = 'cashrain'", [emailN1]);
                let emailN2 = userN2.rows.length > 0 ? normalizarEmail(userN2.rows[0].indicado_por) : null;

                if (emailN2 && emailN2 !== emailUser && emailN2 !== emailN1) {
                    const comissao2 = (rewardAmount * comissaoN2).toFixed(8);
                    await client.query(
                        `INSERT INTO historico_ganhos (projeto, email, origem, pontos, nome_tarefa, referencia_id, data_registro)
                         VALUES ('cashrain', $1, 'indicacao_n2', CAST($2 AS NUMERIC), 'Comissão Nível 2', $3, NOW())
                         ON CONFLICT DO NOTHING`,
                        [emailN2, comissao2, viewId + '_n2']
                    );

                    const userN3 = await client.query("SELECT indicado_por FROM usuarios WHERE LOWER(email) = LOWER($1) AND projeto = 'cashrain'", [emailN2]);
                    let emailN3 = userN3.rows.length > 0 ? normalizarEmail(userN3.rows[0].indicado_por) : null;

                    if (emailN3 && emailN3 !== emailUser && emailN3 !== emailN1 && emailN3 !== emailN2) {
                        const comissao3 = (rewardAmount * comissaoN3).toFixed(8);
                        await client.query(
                            `INSERT INTO historico_ganhos (projeto, email, origem, pontos, nome_tarefa, referencia_id, data_registro)
                             VALUES ('cashrain', $1, 'indicacao_n3', CAST($2 AS NUMERIC), 'Comissão Nível 3', $3, NOW())
                             ON CONFLICT DO NOTHING`,
                            [emailN3, comissao3, viewId + '_n3']
                        );
                    }
                }
            }
            processados++;
        }

        res.json({ success: true, processados: processados, mensagem: `${processados} lotes de comissões verificados e distribuídos com sucesso!` });
    } catch (err) {
        console.error("Erro ao processar comissões pendentes:", err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// ==========================================
// ROTA ADMIN PARA SQL
// ==========================================
app.post('/api/admin/sql', async (req, res) => {
    const { senha, query } = req.body;
    const ADMIN_SENHA = process.env.ADMIN_SENHA;

    if (senha !== ADMIN_SENHA) {
        return res.status(403).json({ success: false, message: 'Senha de administrador inválida.' });
    }

    if (!query || !query.trim()) {
        return res.status(400).json({ success: false, message: 'Nenhuma query SQL foi enviada.' });
    }

    try {
        const resultado = await pool.query(query);
        res.json({
            success: true,
            rowCount: resultado.rowCount,
            rows: resultado.rows
        });
    } catch (err) {
        console.error('Erro ao executar query SQL:', err);
        res.json({ success: false, error: err.message });
    }
});

// ==========================================
// ROTA PARA REGISTRAR MÉTRICAS UTM
// ==========================================
app.post('/api/registrar-metrica', async (req, res) => {
    const { projeto, email_afiliado, utm_source, utm_medium, utm_campaign, acao } = req.body;

    if (!projeto || !email_afiliado || !acao) {
        return res.status(400).json({ success: false, message: 'Dados incompletos.' });
    }

    const emailLimpo = normalizarEmail(email_afiliado);

    try {
        await pool.query(
            `INSERT INTO metricas_divulgacao (projeto, email_afiliado, utm_source, utm_medium, utm_campaign, acao, data_registro)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [projeto, emailLimpo, utm_source || 'direto', utm_medium || 'indefinido', utm_campaign || 'geral', acao]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao registrar métrica:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Inicialização
app.listen(PORT, async () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    await inicializarBanco();
});
