const express = require('express');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Conexão com o PostgreSQL (Render fornece DATABASE_URL automaticamente)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// 1. ROTAS DE FRONTEND (Páginas Web)
app.get('/cashrain', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cashrain.html')));
app.get('/faucet', (req, res) => res.sendFile(path.join(__dirname, 'public', 'faucet.html')));
app.get('/zerads', (req, res) => res.sendFile(path.join(__dirname, 'public', 'zerads.html')));
app.get('/mineracao', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mineracao.html')));

// 2. CONSULTAR SALDO DO USUÁRIO
app.get('/api/saldo', async (req, res) => {
    const { projeto, email } = req.query;
    if (!projeto || !email) return res.status(400).json({ error: 'Parâmetros inválidos' });

    try {
        // Soma os ganhos positivos e subtrai os saques
        const queryGanhos = 'SELECT COALESCE(SUM(pontos), 0) as total FROM historico_ganhos WHERE projeto = $1 AND email = $2';
        const querySaques = 'SELECT COALESCE(SUM(pontos_solicitados), 0) as total FROM saques WHERE projeto = $1 AND email = $2 AND status != \'rejected\'';

        const resGanhos = await pool.query(queryGanhos, [projeto, email]);
        const resSaques = await pool.query(querySaques, [projeto, email]);

        const totalGanho = parseFloat(resGanhos.rows[0].total);
        const totalSacado = parseFloat(resSaques.rows[0].total);
        const saldoDisponivel = (totalGanho - totalSacado).toFixed(8);

        res.json({ saldo: saldoDisponivel });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

// 3. ROTA DE POSTBACK (Para registrar ganhos de anúncios/offerwalls)
app.get('/api/postback/:projeto', async (req, res) => {
    const { projeto } = req.params;
    const { email, reward, origem } = req.query;

    if (!email || !reward) return res.status(400).send('Dados insuficientes');

    try {
        await pool.query(
            'INSERT INTO historico_ganhos (projeto, email, origem, pontos) VALUES ($1, $2, $3, $4)',
            [projeto, email, origem || 'postback', parseFloat(reward)]
        );
        res.status(200).send('OK');
    } catch (err) {
        console.error(err);
        res.status(500).send('Erro no postback');
    }
});

// 4. SOLICITAÇÃO DE SAQUE UNIFICADA
app.post('/api/solicitar-saque', async (req, res) => {
    const { projeto, email } = req.body;
    if (!projeto || !email) return res.status(400).json({ message: 'Dados incompletos.' });

    try {
        // Valida saldo atual antes de permitir o pedido
        const resGanhos = await pool.query('SELECT COALESCE(SUM(pontos), 0) as total FROM historico_ganhos WHERE projeto = $1 AND email = $2', [projeto, email]);
        const resSaques = await pool.query('SELECT COALESCE(SUM(pontos_solicitados), 0) as total FROM saques WHERE projeto = $1 AND email = $2 AND status != \'rejected\'', [projeto, email]);
        
        const saldo = parseFloat(resGanhos.rows[0].total) - parseFloat(resSaques.rows[0].total);

        if (saldo <= 0) {
            return.json({ message: 'Saldo insuficiente para saque.' });
        }

        // Insere na tabela de saques pendentes
        await pool.query(
            `INSERT INTO saques (projeto, email, pontos_solicitados, valor_solicitado, chave_pix, status) 
             VALUES ($1, $2, $3, $4, $5, 'Waiting')`,
            [projeto, email, saldo, 0.04, email]
        );

        res.json({ success: true, message: 'Saque solicitado com sucesso! Aguardando aprovação no painel admin.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao solicitar saque.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
