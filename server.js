const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.MONEYRAIN_SECRET 

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

            CREATE INDEX IF NOT EXISTS idx_saques_status ON saques(status);
            CREATE INDEX IF NOT EXISTS idx_ganhos_email ON historico_ganhos(email);
            CREATE INDEX IF NOT EXISTS idx_ganhos_ref ON historico_ganhos(referencia_id);
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

// ==========================================
// REGISTRO / LOGIN COM INDICAÇÃO
// ==========================================
app.post('/api/login', async (req, res) => {
    const { projeto, email, indicado_por } = req.body;

    if (!projeto || !email) {
        return res.status(400).json({ success: false, message: 'Dados incompletos.' });
    }

    try {
        let padrinho = indicado_por;
        if (padrinho === email) padrinho = null;

        await pool.query(
            `INSERT INTO usuarios (projeto, email, indicado_por) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (projeto, email) 
             DO UPDATE SET indicado_por = COALESCE(usuarios.indicado_por, EXCLUDED.indicado_por)`,
            [projeto, email, padrinho]
        );

        res.json({ success: true, message: 'Login efetuado com sucesso!' });
    } catch (err) {
        console.error('Erro no login:', err);
        res.status(500).json({ success: false, message: 'Erro interno no login.' });
    }
});

// ==========================================
// CONSULTA DE SALDO
// ==========================================
app.get('/api/saldo', async (req, res) => {
    const { projeto, email } = req.query;
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
        const saldoDisponivel = (totalGanho - totalSacado).toFixed(8);

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
// SOLICITAÇÃO DE SAQUE (PENDENTE / WAITING)
// ==========================================
app.post('/api/solicitar-saque', async (req, res) => {
    const { projeto, email, chave_pix_faucetpay } = req.body;
    const destino = chave_pix_faucetpay || email;

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
        const minimoSaque = 0.01;

        if (saldoDisponivel < minimoSaque) {
            await client.query('ROLLBACK');
            return.json({ success: false, message: `Saldo insuficiente. Mínimo para saque é ${minimoSaque}.` });
        }

        await client.query(
            `INSERT INTO saques (projeto, email, pontos_solicitados, valor_solicitado, chave_pix, status, data_solicitacao) 
             VALUES ($1, $2, $3, $4, $5, 'Waiting', NOW())`,
            [projeto, destino, saldoDisponivel, saldoDisponivel, destino]
        );

        await client.query('COMMIT');
        res.json({ 
            success: true, 
            message: 'Saque solicitado com sucesso! Aguardando pagamento manual.' 
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Erro ao solicitar saque:', err);
        res.status(500).json({ success: false, message: 'Erro interno ao processar solicitação.' });
    } finally {
        client.release();
    }
});

// ==========================================
// CALLBACK MONEYRAIN COM 3 NÍVEIS E HMAC
// ==========================================
app.post('/api/moneyrain-callback', async (req, res) => {
    const signature = req.headers['x-moneyrain-signature'];
    
    const percentualUsuario = 0.70; 
    const comissaoN1 = 0.05; 
    const comissaoN2 = 0.03; 
    const comissaoN3 = 0.02; 

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
        const emailUser = data.external_uid;
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

            // Credita 70% para o usuário
            const ganhoLiquidoUsuario = (rewardAmount * percentualUsuario).toFixed(8);
            await client.query(
                `INSERT INTO historico_ganhos (projeto, email, origem, pontos, nome_tarefa, referencia_id, data_registro) 
                 VALUES ('cashrain', $1, 'moneyrain', CAST($2 AS NUMERIC), $3, $4, NOW())`,
                [emailUser, ganhoLiquidoUsuario, nomeTarefa, viewId.toString()]
            );

            // Nível 1 (5%)
            const resN1 = await client.query("SELECT indicado_por FROM usuarios WHERE email = $1 AND projeto = 'cashrain'", [emailUser]);
            let emailN1 = resN1.rows.length > 0 ? resN1.rows[0].indicado_por : null;

            if (emailN1) {
                const comissao1 = (rewardAmount * comissaoN1).toFixed(8);
                await client.query(
                    `INSERT INTO historico_ganhos (projeto, email, origem, pontos, nome_tarefa, referencia_id, data_registro) 
                     VALUES ('cashrain', $1, 'indicacao_n1', CAST($2 AS NUMERIC), 'Comissão Nível 1', $3 || '_n1', NOW())`,
                    [emailN1, comissao1, viewId.toString()]
                );

                // Nível 2 (3%)
                const resN2 = await client.query("SELECT indicado_por FROM usuarios WHERE email = $1 AND projeto = 'cashrain'", [emailN1]);
                let emailN2 = resN2.rows.length > 0 ? resN2.rows[0].indicado_por : null;

                if (emailN2) {
                    const comissao2 = (rewardAmount * comissaoN2).toFixed(8);
                    await client.query(
                        `INSERT INTO historico_ganhos (projeto, email, origem, pontos, nome_tarefa, referencia_id, data_registro) 
                         VALUES ('cashrain', $1, 'indicacao_n2', CAST($2 AS NUMERIC), 'Comissão Nível 2', $3 || '_n2', NOW())`,
                        [emailN2, comissao2, viewId.toString()]
                    );

                    // Nível 3 (2%)
                    const resN3 = await client.query("SELECT indicado_por FROM usuarios WHERE email = $1 AND projeto = 'cashrain'", [emailN2]);
                    let emailN3 = resN3.rows.length > 0 ? resN3.rows[0].indicado_por : null;

                    if (emailN3) {
                        const comissao3 = (rewardAmount * comissaoN3).toFixed(8);
                        await client.query(
                            `INSERT INTO historico_ganhos (projeto, email, origem, pontos, nome_tarefa, referencia_id, data_registro) 
                             VALUES ('cashrain', $1, 'indicacao_n3', CAST($2 AS NUMERIC), 'Comissão Nível 3', $3 || '_n3', NOW())`,
                            [emailN3, comissao3, viewId.toString()]
                        );
                    }
                }
            }

            await client.query('COMMIT');
            console.log(`✅ MoneyRain Postback Sucesso! Usuário ${emailUser} creditado.`);
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

// Inicialização
app.listen(PORT, async () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    await inicializarBanco();
});
