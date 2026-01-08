// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');

// @desc    Verify JWT token and protect routes
// @usage   Add as middleware to protected routes
exports.authenticateToken = (req, res, next) => {
  // Get token from header
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer TOKEN"

  // Check if token exists
  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Access denied. No token provided.' 
    });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Add user info to request object
    req.user = decoded;
    
    // Continue to next middleware/route handler
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(403).json({ 
        success: false, 
        message: 'Token expired. Please login again.' 
      });
    }
    
    return res.status(403).json({ 
      success: false, 
      message: 'Invalid token. Access denied.' 
    });
  }
};

// @desc    Check if user is a customer
// @usage   Add after authenticateToken middleware
exports.isCustomer = (req, res, next) => {
  if (req.user && req.user.userType === 'customer') {
    next();
  } else {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Customers only.'
    });
  }
};

// @desc    Check if user is an agent
// @usage   Add after authenticateToken middleware
exports.isAgent = (req, res, next) => {
  if (req.user && req.user.userType === 'agent') {
    next();
  } else {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Agents only.'
    });
  }
};

// @desc    Validate request body fields
// @usage   validateFields(['name', 'email', 'phone'])
exports.validateFields = (requiredFields) => {
  return (req, res, next) => {
    const missingFields = [];
    
    for (const field of requiredFields) {
      if (!req.body[field]) {
        missingFields.push(field);
      }
    }
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`
      });
    }
    
    next();
  };
};