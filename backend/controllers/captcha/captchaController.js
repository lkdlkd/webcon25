const axios = require('axios');

// Lấy reCAPTCHA site key (public key) để frontend sử dụng
exports.getSiteKey = async (req, res) => {
    try {
        const siteKey = process.env.RECAPTCHA_SITE_KEY;
        if (!siteKey) {
            return res.status(500).json({ error: 'reCAPTCHA chưa được cấu hình' });
        }
        return res.status(200).json({ siteKey });
    } catch (error) {
        console.error('Lỗi lấy reCAPTCHA site key:', error);
        return res.status(500).json({ error: 'Có lỗi xảy ra' });
    }
};

// Xác thực reCAPTCHA token với Google
exports.verifyRecaptcha = async (recaptchaToken) => {
    if (!recaptchaToken) {
        return { success: false, message: 'Vui lòng xác nhận bạn không phải là người máy' };
    }

    const secretKey = process.env.RECAPTCHA_SECRET_KEY;
    if (!secretKey) {
        console.error('RECAPTCHA_SECRET_KEY chưa được cấu hình');
        return { success: false, message: 'reCAPTCHA chưa được cấu hình trên server' };
    }

    try {
        const response = await axios.post(
            'https://www.google.com/recaptcha/api/siteverify',
            null,
            {
                params: {
                    secret: secretKey,
                    response: recaptchaToken
                }
            }
        );

        if (response.data.success) {
            return { success: true };
        } else {
            console.log('reCAPTCHA verification failed:', response.data['error-codes']);
            return { success: false, message: 'Xác thực reCAPTCHA thất bại. Vui lòng thử lại.' };
        }
    } catch (error) {
        console.error('Lỗi xác thực reCAPTCHA:', error.message);
        return { success: false, message: 'Lỗi xác thực reCAPTCHA. Vui lòng thử lại.' };
    }
};
