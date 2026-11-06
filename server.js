const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.MONEYRAIN_SECRET;

// Função auxiliar para normalizar e-mails (evita conflitos com pontos do Gmail e maiúsculas)
function normalizarEmail(email) {
    if (!email) return '';
    let limpo = email.trim().toLowerCase();
    if (limpo.endsWith('@gmail.com') || limpo.endsWith('@googlemail.com')) {
        let partes = limpo.split('@');
        let usuario = partes[0].replace(/\./g, '');
        return `${usuario}@${partes[1]}`;
    }
    return limpo;
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
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

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

    // Se não veio indicação explícita e não é a conta raiz, joga para o Chenson por padrão
    if (!indicado_por && email !== 'chensonbh763@gmail.com') {
        indicado_por = 'chensonbh763@gmail.com';
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Insere ou atualiza o usuário, garantindo que o link de indicação seja atualizado caso ele entre por outro link
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
// SOLICITAÇÃO DE SAQUE
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
        const minimoSaque = 0.01;

        if (saldoDisponivel < minimoSaque) {
            await client.query('ROLLBACK');
            return res.json({ success: false, message: `Saldo insuficiente. Mínimo para saque é ${minimoSaque}.` });
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
// CALLBACK MONEYRAIN COM ÁRVORE DINÂMICA EM 3 NÍVEIS
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

            // 1. Credita 70% para o usuário principal da tarefa
            const ganhoLiquidoUsuario = (rewardAmount * percentualUsuario).toFixed(8);
            await client.query(
                `INSERT INTO historico_ganhos (projeto, email, origem, pontos, nome_tarefa, referencia_id, data_registro) 
                 VALUES ('cashrain', $1, 'moneyrain', CAST($2 AS NUMERIC), $3, $4, NOW())`,
                [emailUser, ganhoLiquidoUsuario, nomeTarefa, viewId.toString()]
            );

            // 2. Busca dinâmica e recursiva da árvore de uplines (N1, N2, N3) direto da tabela no momento do postback
            const queryArvore = `
                WITH RECURSIVE uplines AS (
                    SELECT email, indicado_por, 1 AS nivel
                    FROM usuarios
                    WHERE email = $1 AND projeto = 'cashrain'
                    
                    UNION ALL
                    
                    SELECT u.email, u.indicado_por, uplines.nivel + 1
                    FROM usuarios u
                    JOIN uplines ON u.email = uplines.indicado_por
                    WHERE uplines.nivel < 3 AND u.projeto = 'cashrain'
                )
                SELECT email, nivel FROM uplines WHERE nivel > 0;
            `;

            const resArvore = await client.query(queryArvore, [emailUser]);

            // Mapeia os níveis encontrados na árvore atualizada
            let emailN1 = null;
            let emailN2 = null;
            let emailN3 = null;

            resArvore.rows.forEach(row => {
                // A query retorna a cadeia a partir do usuário, então pegamos quem indicou
                // Para simplificar, vamos buscar os pais diretos na tabela com base na hierarquia
            });

            // Abordagem direta e blindada para buscar N1, N2 e N3 em cadeia na tabela:
            const userN1 = await client.query("SELECT indicado_por FROM usuarios WHERE email = $1 AND projeto = 'cashrain'", [emailUser]);
            emailN1 = userN1.rows.length > 0 ? normalizarEmail(userN1.rows[0].indicado_por) : null;

            if (emailN1) {
                const comissao1 = (rewardAmount * comissaoN1).toFixed(8);
                await client.query(
                    `INSERT INTO historico_ganhos (projeto, email, origem, pontos, nome_tarefa, referencia_id, data_registro) 
                     VALUES ('cashrain', $1, 'indicacao_n1', CAST($2 AS NUMERIC), 'Comissão Nível 1', $3 || '_n1', NOW())`,
                    [emailN1, comissao1, viewId.toString()]
                );

                const userN2 = await client.query("SELECT indicado_por FROM usuarios WHERE email = $1 AND projeto = 'cashrain'", [emailN1]);
                emailN2 = userN2.rows.length > 0 ? normalizarEmail(userN2.rows[0].indicado_por) : null;

                if (emailN2) {
                    const comissao2 = (rewardAmount * comissaoN2).toFixed(8);
                    await client.query(
                        `INSERT INTO historico_ganhos (projeto, email, origem, pontos, nome_tarefa, referencia_id, data_registro) 
                         VALUES ('cashrain', $1, 'indicacao_n2', CAST($2 AS NUMERIC), 'Comissão Nível 2', $3 || '_n2', NOW())`,
                        [emailN2, comissao2, viewId.toString()]
                    );

                    const userN3 = await client.query("SELECT indicado_por FROM usuarios WHERE email = $1 AND projeto = 'cashrain'", [emailN2]);
                    emailN3 = userN3.rows.length > 0 ? normalizarEmail(userN3.rows[0].indicado_por) : null;

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
            console.log(`✅ MoneyRain Postback Sucesso! Cadeia de comissões processada para ${emailUser}.`);
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
// ROTA ADMIN PARA SQL
// ==========================================
app.post('/api/admin/sql', async (req, res) => {
    const { senha, query } = req.body;
    const ADMIN_SENHA = process.env.ADMIN_SENHA;

    if (senha !== ADMIN_SENHA) {
        return res.status(403).json({ success: false, message: 'Senha de administrador inválida.' });
    }

    if (!query || !query.trim()) {
        return res.status(400).json({ success: false, message: 'Nenhuma query SQL foi enviada.'VN });
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

// Inicialização
app.listen(PORT, async () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    await inicializarBanco();
});
